'use strict';

/**
 * Normaliza o Pix copia e cola no padrão EMV BR Code.
 * O Mercado Pago já fornece o payload completo; aqui validamos os TLVs e
 * recalculamos somente o CRC16-CCITT obrigatório (campo 63), sem alterar a
 * chave, o valor ou os dados do recebedor.
 */
function crc16Ccitt(texto) {
  let crc = 0xffff;
  for (const byte of Buffer.from(String(texto), 'utf8')) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}
function limparPayload(valor) {
  return String(valor ?? '').replace(/`/g, '').replace(/[\r\n]/g, '').trim();
}
function lerTLV(payload) {
  const campos = [];
  for (let pos = 0; pos < payload.length;) {
    if (pos + 4 > payload.length || !/^\d{4}$/.test(payload.slice(pos, pos + 4))) throw new Error('Pix EMV inválido: TLV incompleto.');
    const id = payload.slice(pos, pos + 2);
    const tamanho = Number(payload.slice(pos + 2, pos + 4));
    const inicio = pos + 4;
    const fim = inicio + tamanho;
    if (!Number.isInteger(tamanho) || fim > payload.length) throw new Error('Pix EMV inválido: tamanho de campo inconsistente.');
    campos.push({ id, valor: payload.slice(inicio, fim) });
    pos = fim;
  }
  return campos;
}
function montarTLV(id, valor) {
  const texto = String(valor);
  if (texto.length > 99) throw new Error(`Pix EMV inválido: campo ${id} excede 99 caracteres.`);
  return `${id}${texto.length.toString().padStart(2, '0')}${texto}`;
}
function normalizarPixPayload(valor) {
  const payload = limparPayload(valor);
  if (!payload || payload.length > 1200) throw new Error('Pix EMV vazio ou acima do limite seguro.');
  const semCrc = payload.endsWith('6304') ? payload.slice(0, -4) : payload;
  const campos = lerTLV(semCrc);
  const crcCampo = campos.find((campo) => campo.id === '63');
  if (crcCampo) {
    if (crcCampo.valor.length !== 4) throw new Error('Pix EMV inválido: CRC malformado.');
    const semCrcReal = semCrc.slice(0, semCrc.lastIndexOf('63'));
    if (crcCampo.valor.toUpperCase() !== crc16Ccitt(`${semCrcReal}6304`)) {
      return `${semCrcReal}6304${crc16Ccitt(`${semCrcReal}6304`)}`;
    }
    return `${semCrcReal}6304${crcCampo.valor.toUpperCase()}`;
  }
  const recalculado = `${semCrc}6304`;
  return `${recalculado}${crc16Ccitt(recalculado)}`;
}
function validarPixPayload(valor) {
  try {
    const normalizado = normalizarPixPayload(valor);
    const campos = lerTLV(normalizado);
    const ids = new Set(campos.map((campo) => campo.id));
    const campo00 = campos.find((campo) => campo.id === '00');
    const campo26 = campos.find((campo) => campo.id === '26');
    if (!ids.has('00') || !ids.has('26') || !ids.has('63') || campo00?.valor !== '01') return false;
    const subcampos = lerTLV(campo26.valor);
    const gui = subcampos.find((campo) => campo.id === '00');
    if (!gui || gui.valor !== 'BR.GOV.BCB.PIX') return false;
    return normalizado;
  } catch {
    return false;
  }
}

/**
 * Valida o payload exatamente como recebido, sem trim, replace ou recálculo.
 * O qr_code do Mercado Pago deve ser repassado byte a byte ao usuário.
 */
function validarPixPayloadExato(valor) {
  try {
    if (typeof valor !== 'string' || !valor || valor.length > 1200 || /[`\r\n]/.test(valor)) return false;
    const campos = lerTLV(valor);
    const ids = new Set(campos.map((campo) => campo.id));
    const campo00 = campos.find((campo) => campo.id === '00');
    const campo26 = campos.find((campo) => campo.id === '26');
    const crc = campos[campos.length - 1];
    if (!ids.has('00') || !ids.has('26') || !campo00 || campo00.valor !== '01' || !crc || crc.id !== '63' || crc.valor.length !== 4) return false;
    const subcampos = lerTLV(campo26.valor);
    const gui = subcampos.find((campo) => campo.id === '00');
    if (!gui || gui.valor !== 'BR.GOV.BCB.PIX') return false;
    const semCrc = valor.slice(0, -8);
    return crc.valor === crc16Ccitt(`${semCrc}6304`);
  } catch {
    return false;
  }
}
module.exports = { crc16Ccitt, limparPayload, normalizarPixPayload, validarPixPayload, validarPixPayloadExato, montarTLV };
