import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fit, imageInfo, pickTemplate, renderArt, TEMPLATES } from '../src/art/render.js';

test('ajuste de texto nunca passa do número de linhas, em qualquer tamanho', () => {
  const long = 'Kit festa com 100 salgados, bolo de 2 kg e refrigerante gelado para a sua comemoração de fim de ano';
  for (let size = 40; size <= 120; size++) for (const min of [28, 30, 33, 34, 48])
    for (const max of [1, 2, 3, 4]) {
      const r = fit(long, 900, size, max, Math.min(min, size));
      assert.ok(r.lines.length >= 1 && r.lines.length <= max, `size ${size} min ${min} max ${max}`);
    }
});

test('todos os modelos renderizam JPG nos três formatos, inclusive com texto enorme e vazio', () => {
  const brand = { name: 'Negócio', primary: '#7A3E12', secondary: '#F2B33D' };
  for (const template of TEMPLATES) for (const format of ['feed', 'story', 'square'] as const)
    for (const headline of ['Oi', 'x'.repeat(5) + ' palavra'.repeat(60), ' ']) {
      const r = renderArt({ template, format, brand, headline, subline: 'apoio '.repeat(40), cta: 'Fale no WhatsApp', slide: { index: 2, total: 5 } });
      const info = imageInfo(r.jpg)!;
      assert.equal(info.mime, 'image/jpeg');
      assert.equal(info.height, format === 'story' ? 1920 : format === 'square' ? 1080 : 1350);
    }
});

test('modelo escolhido pela dica da IA', () => {
  assert.equal(pickTemplate('oferta-do-dia', 'post'), 'oferta');
  assert.equal(pickTemplate('bastidores da cozinha', 'post'), 'bastidores');
  assert.equal(pickTemplate('qualquer', 'carousel'), 'carrossel');
  assert.equal(pickTemplate(undefined, 'post'), 'destaque');
});
