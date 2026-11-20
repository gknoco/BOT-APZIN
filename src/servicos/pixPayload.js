'use strict';

// O CRC cobre os bytes UTF-8, inclusive o identificador e tamanho "6304".
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

// Compatibilidade com chamadas antigas: um Pix fornecido pelo PSP é opaco e
// jamais pode ser limpo, recortado, normalizado ou ter o CRC substituído.
function limparPayload(valor) {
  return valor;
}

function lerTLV(payload) {
  // O tamanho EMV é em caracteres, não em unidades UTF-16 ou bytes UTF-8.
  const caracteres = Array.from(payload);
  const campos = [];
  const ids = new Set();
  for (let pos = 0; pos < caracteres.length;) {
    const cabecalho = caracteres.slice(pos, pos + 4).join('');
    if (!/^\d{4}$/.test(cabecalho)) throw new Error('Pix EMV inválido: TLV incompleto.');
    const id = cabecalho.slice(0, 2);
    const tamanho = Number(cabecalho.slice(2));
    const inicio = pos + 4;
    const fim = inicio + tamanho;
    if (!tamanho || fim > caracteres.length || ids.has(id)) throw new Error('Pix EMV inválido: tamanho ou identificador de campo inconsistente.');
    ids.add(id);
    campos.push({ id, valor: caracteres.slice(inicio, fim).join('') });
    pos = fim;
  }
  return campos;
}

function montarTLV(id, valor) {
  const texto = String(valor);
  const tamanho = Array.from(texto).length;
  if (!/^\d{2}$/.test(String(id)) || tamanho < 1 || tamanho > 99) throw new Error(`Pix EMV inválido: campo ${id} com identificador ou comprimento inválido.`);
  return `${id}${tamanho.toString().padStart(2, '0')}${texto}`;
}

/** Verifica estrutura e CRC sem jamais reconstruir o código recebido do PSP. */
function validarPixPayloadExato(valor) {
  try {
    // NUL não pode ser persistido em uma coluna text do PostgreSQL; pares
    // substitutos isolados também não admitem uma representação UTF-8 fiel.
    if (typeof valor !== 'string' || !valor || valor.length > 3000 || valor.includes('\0') || !valor.isWellFormed()) return false;
    const campos = lerTLV(valor);
    const primeiro = campos[0];
    const crc = campos.at(-1);
    if (primeiro?.id !== '00' || primeiro.valor !== '01' || crc?.id !== '63' || !/^[0-9A-F]{4}$/.test(crc.valor)) return false;
    if (crc.valor !== crc16Ccitt(valor.slice(0, -4))) return false;
    // O GUI Pix é case-insensitive e pode estar em qualquer ID de 26 a 51.
    return campos.some((campo) => {
      const id = Number(campo.id);
      if (id < 26 || id > 51) return false;
      try {
        return lerTLV(campo.valor).some((subcampo) => subcampo.id === '00' && subcampo.valor.toLowerCase() === 'br.gov.bcb.pix');
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function validarPixPayload(valor) {
  return validarPixPayloadExato(valor) ? valor : false;
}

function normalizarPixPayload(valor) {
  if (!validarPixPayloadExato(valor)) throw new Error('Pix EMV inválido: estrutura ou CRC inconsistente.');
  return valor;
}

module.exports = { crc16Ccitt, limparPayload, normalizarPixPayload, validarPixPayload, validarPixPayloadExato, montarTLV };
