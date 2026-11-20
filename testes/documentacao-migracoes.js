'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const raiz = path.join(__dirname, '..');

test('README lista todas as migrações do repositório em ordem', () => {
  const arquivos = fs.readdirSync(path.join(raiz, 'supabase', 'migrations'))
    .filter((nome) => nome.endsWith('.sql'))
    .sort();
  const readme = fs.readFileSync(path.join(raiz, 'README.md'), 'utf8');
  const documentadas = [...readme.matchAll(/^\s*- `supabase\/migrations\/([^`]+\.sql)`\s*$/gm)]
    .map((resultado) => resultado[1]);
  assert.deepEqual(documentadas, arquivos, 'Atualize a sequência de migrações no README');
});
