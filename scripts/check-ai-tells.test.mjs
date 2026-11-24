// node --test --test-timeout=120000 --test-force-exit scripts/check-ai-tells.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { check, findTells, isLegal, isLocaleFile, langOfPath, langOfText, stringsOf, main } from './check-ai-tells.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tells-'))
const put = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text) }

test('English tells from avoid-ai-writing are found, whole words only', () => {
  assert.deepEqual(findTells('A seamless, robust way to delve in.', 'en'), ['delve', 'robust', 'seamless'])
  assert.deepEqual(findTells('Delivered to the robustness lab', 'en'), [])
  assert.deepEqual(findTells('Letters, digits and underscores only.', 'en'), [])
  assert.deepEqual(findTells('Please do not hesitate to ask', 'en'), ['do not hesitate'])
})

test('placeholders and markup are not read as words', () => {
  assert.deepEqual(findTells('Hello {robust} <b>there</b>', 'en'), [])
})

test('em-dash chains are flagged; one dash is fine in English; Russian dashes are native', () => {
  assert.deepEqual(findTells('Fast — and cheap — and safe.', 'en'), ['em-dash chain'])
  assert.deepEqual(findTells('Fast — and cheap.', 'en'), [])
  assert.deepEqual(findTells('Москва — столица — России', 'ru'), [])
})

test('Vietnamese: em dash, một cách + adjective, hàng đầu, not their ordinary uses', () => {
  assert.deepEqual(findTells('Giá để trên trang — không giấu.', 'vi'), ['em dash in Vietnamese'])
  assert.deepEqual(findTells('Hệ thống chạy một cách ổn định.', 'vi'), ['một cách + adjective'])
  assert.deepEqual(findTells('Phòng lớn cần một cách truyền hình ảnh khác.', 'vi'), [])
  assert.deepEqual(findTells('Trước khi có khách hàng đầu tiên.', 'vi'), [])
  assert.deepEqual(findTells('Nhà cung cấp hàng đầu thế giới.', 'vi'), ['hàng đầu'])
})

test('CJK, Korean, Hindi and Russian lists', () => {
  assert.deepEqual(findTells('我们为企业赋能', 'zh'), ['赋能'])
  assert.deepEqual(findTells('{app}을(를) 여는 중이에요', 'ko'), ['을(를)'])
  assert.deepEqual(findTells('シームレスな体験', 'ja'), ['シームレス'])
  assert.deepEqual(findTells('बेझिझक संपर्क करें', 'hi'), ['बेझिझक'])
  assert.deepEqual(findTells('Бесшовная интеграция', 'ru'), ['бесшовн*'])
  assert.deepEqual(findTells('Швы ровные', 'ru'), [])
})

test('language comes from the path, a block or the script', () => {
  assert.equal(langOfPath('src/locales/vi.json'), 'vi')
  assert.equal(langOfPath('web/src/i18n/messages/ko/agents.ts'), 'ko')
  assert.equal(langOfPath('src/i18n/zh-CN.json'), 'zh')
  assert.equal(langOfText('Привет'), 'ru')
  assert.equal(langOfText('Xin chào bạn'), 'vi')
  assert.equal(langOfText('こんにちは'), 'ja')
  const s = stringsOf('src/i18n/copy.ts', "export const copy = {\n  en: {\n    a: 'A seamless thing',\n  },\n  vi: {\n    a: 'Một thứ liền mạch',\n  },\n}\n")
  assert.deepEqual(s.map((x) => x.lang), ['en', 'vi'])
})

test('locale files: catalogs yes; code under scripts, tests, other languages and legal text no', () => {
  assert.ok(isLocaleFile('src/locales/en.json'))
  assert.ok(isLocaleFile('src/i18n/billing.ts'))
  assert.ok(!isLocaleFile('scripts/i18n/check-parity.mjs'))
  assert.ok(!isLocaleFile('src/i18n/billing.test.ts'))
  assert.ok(!isLocaleFile('src/locales/fr.json'))
  assert.ok(!isLocaleFile('src/components/App.vue'))
})

test('check() reports tells, honours the allow file with a reason and skips legal text', () => {
  const root = tmp()
  put(root, 'src/locales/en.json', JSON.stringify({ hero: { title: 'A seamless way in' }, legal: { terms: 'robust terms' } }))
  put(root, 'src/locales/terms/en.json', JSON.stringify({ a: 'comprehensive cover' }))
  put(root, 'src/locales/vi.json', JSON.stringify({ hero: { title: 'Cách vào liền mạch' } }))
  let found = check(root)
  assert.deepEqual(found.map((f) => [f.file, f.key, f.phrase]), [
    ['src/locales/en.json', 'hero.title', 'seamless'],
    ['src/locales/vi.json', 'hero.title', 'liền mạch'],
  ])
  put(root, '.ai-tells-allow.json', JSON.stringify({ allow: [{ path: 'src/locales/vi.json', phrase: 'liền mạch', reason: 'product name' }] }))
  found = check(root)
  assert.equal(found.length, 1)
  put(root, '.ai-tells-allow.json', JSON.stringify({ allow: [{ phrase: 'seamless' }] }))
  assert.throws(() => check(root), /reason/)
})

test('main() exits 1 on a tell and 0 when clean', () => {
  const root = tmp()
  put(root, 'src/locales/en.json', JSON.stringify({ a: 'We will leverage it' }))
  const out = []
  assert.equal(main([root], (s) => out.push(s)), 1)
  assert.match(out.join(''), /leverage/)
  put(root, 'src/locales/en.json', JSON.stringify({ a: 'We will use it' }))
  assert.equal(main([root], () => {}), 0)
})

test('review regressions: legal words match whole first words only', () => {
  assert.ok(isLegal('legal.title'))
  assert.ok(isLegal('termsOfService.body'))
  assert.ok(isLegal('src/locales/privacy/en.json'))
  assert.ok(!isLegal('photos.title'))
  assert.ok(!isLegal('settings.autosave'))
  assert.ok(!isLegal('passwordPolicy.hint'))
  assert.ok(!isLegal('searchTerms.placeholder'))
})

test('review regressions: language detection', () => {
  assert.equal(langOfText('Ouvrir la fenêtre'), 'en')
  assert.equal(langOfText('Mở cửa sổ'), 'vi')
  assert.equal(langOfPath('src/locales/messages.fr.json'), 'other')
  assert.ok(!isLocaleFile('src/locales/messages.fr.json'))
  assert.ok(isLocaleFile('apps/my-app/src/locales/en.json'))
  assert.ok(isLocaleFile('packages/id-card/i18n/en.json'))
  assert.ok(!isLocaleFile('tests/i18n/en.json'))
  assert.equal(langOfPath('src/i18n/hi-res/strings.json'), null)
  const s = stringsOf('src/i18n/copy.ts', "const en = {\n  a: 'A seamless thing',\n}\nconst de = {\n  a: 'Das ist robust und gut',\n}\nexport const ja: Full = {\n  t: '料金 — Terranimus',\n}\n")
  assert.deepEqual(s.map((x) => x.lang), ['en', 'other', 'ja'])
  const j = stringsOf('src/i18n/all.json', JSON.stringify({ greeting: { hi: 'Kindly sign in' }, vi: { a: 'Xin chào' } }))
  assert.deepEqual(j.map((x) => x.lang), [undefined, 'vi'])
})

test('review regressions: native forms are not flagged; real tells still are', () => {
  assert.deepEqual(findTells('トップピックはバンフ——乗り継ぎ8時間', 'ja'), [])
  assert.deepEqual(findTells('на данный момент', 'ru'), [])
  assert.deepEqual(findTells('Данная функция недоступна', 'ru'), ['данный'])
  assert.deepEqual(findTells('не является ключевым словом', 'ru'), [])
  assert.deepEqual(findTells('Ваши данные в безопасности', 'ru'), [])
  assert.deepEqual(findTells('Как ИИ анализирует ваши данные', 'ru'), [])
  assert.deepEqual(findTells('敬请期待', 'zh'), [])
  assert.deepEqual(findTells('Một cách đơn giản để chia sẻ', 'vi'), [])
  assert.deepEqual(findTells('Cố định hàng đầu', 'vi'), [])
  assert.deepEqual(findTells('Đồng bộ liền mạch'.normalize('NFD'), 'vi'), ['liền mạch'])
  assert.deepEqual(findTells('{n, plural, one {Seamless sync} other {# syncs}}', 'en'), ['seamless'])
  assert.deepEqual(findTells('我們提供無縫體驗', 'zh'), ['無縫'])
  assert.deepEqual(findTells('Sign in to the realm', 'en'), [])
})

test('review regressions: single-word values in TS catalogs are read', () => {
  const s = stringsOf('src/i18n/copy.ts', "export default {\n  badge: 'Seamless',\n  id: 'primary',\n}\n")
  assert.deepEqual(s.map((x) => x.text), ['Seamless'])
})

test('review regressions: a missing folder or a bad allow file exits 2, not 0 or 1', () => {
  assert.equal(main([path.join(os.tmpdir(), 'no-such-folder-ai-tells')], () => {}, () => {}), 2)
  const root = tmp()
  put(root, 'src/locales/en.json', JSON.stringify({ a: 'fine' }))
  put(root, '.ai-tells-allow.json', '{ not json')
  assert.equal(main([root], () => {}, () => {}), 2)
})

test('second review: a declaration that is not a language resets the block; camelCase names and scripts win', () => {
  const src = "const vi: ExtraCatalog = {\n  a: 'Lưu một cách an toàn rồi',\n}\nconst zhHans: ExtraCatalog = {\n  a: '我们提供无缝体验',\n}\nconst extraEn = {\n  a: 'A seamless thing',\n}\nconst helpers = {\n  a: 'Plain words here',\n}\n"
  const s = stringsOf('src/i18n/extra.ts', src)
  assert.deepEqual(s.map((x) => x.lang), ['vi', 'zh', 'en', null])
  const root = tmp()
  put(root, 'src/i18n/extra.ts', "const vi = {\n  a: 'Xin chào bạn nhé',\n  b: '我们提供无缝体验',\n}\n")
  assert.deepEqual(check(root).map((f) => [f.lang, f.phrase]), [['zh', '无缝']])
})

test('second review: sentence keys are text, not legal sections', () => {
  assert.ok(!isLegal('Your privacy matters to us'))
  assert.ok(isLegal('privacy.title'))
})
