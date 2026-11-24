#!/usr/bin/env node
// check-ai-tells: flag AI-writing tells and translation tells in an app's user-facing strings (i18n catalogs).
// Copied from AI.Template (rules/native-writing.md). Dependency-free (node:fs, node:path).
//
//   node scripts/check-ai-tells.mjs [root ...] [--json] [--files]
//
// It finds locale files (a path segment named locales, locale, i18n, lang, langs, messages, translations or l10n, or a file
// named like en.json / vi.ts / zh-CN.json inside one), reads every string value, works out its language (file name, an
// "en: {" block, or the script of the text) and reports each banned phrase. Exit 1 when anything is found, 0 when clean,
// 2 on a usage error.
//
// Phrases: English comes from avoid-ai-writing (github.com/conorbronsdon/avoid-ai-writing @ cd5573a, MIT): its Tier 1A
// words and its chatbot artifacts, plus the stock service lines of multilingual-native-copy. The other six languages are
// this repo's lists (.claude/skills/avoid-ai-writing/references/terranimus-languages.md). An entry ending in "*" matches a
// word prefix (Russian endings); an entry { label, re } is a regular expression. Latin and Cyrillic entries match whole words; CJK and Devanagari entries match anywhere.
//
// Legal text is never checked (a path or key segment starting with legal, terms, privacy, licence, gdpr, tos, eula, consent ...).
// Exceptions: .ai-tells-allow.json at the root: { "allow": [ { "path": "src/i18n/en.json", "key": "pricing", "phrase":
// "comprehensive", "reason": "..." } ] }. "path" and "key" are substrings; "reason" is required.
// Exit 2 (not 1) for a missing folder or a malformed allow file, so a typo never reads as clean or as a finding.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PHRASES = {
  en: [
    'delve', 'delves', 'delving', 'tapestry', 'testament to', 'paradigm', 'embark', 'robust', 'comprehensive',
    'cutting-edge', 'leverage', 'leverages', 'leveraging', 'pivotal', 'meticulous', 'meticulously',
    'seamless', 'seamlessly', 'game-changer', 'game-changing', 'watershed moment', 'the future looks bright',
    'only time will tell', 'nestled', 'vibrant', 'thriving', 'showcasing', 'deep dive', 'bustling', 'intricate',
    'intricacies', 'ever-evolving', 'daunting', 'holistic', 'holistically', 'actionable', 'impactful', 'learnings',
    'thought leadership', 'at its core', 'synergy', 'synergies', 'interplay', 'world-class', 'state-of-the-art',
    'best-in-class', 'supercharge', 'supercharged', 'unleash', 'harness the power', 'revolutionize', 'revolutionise',
    'revolutionizing', 'revolutionising', "in today's fast-paced", 'in today’s fast-paced', "it's worth noting",
    'it’s worth noting', 'it is worth noting', 'i hope this helps', 'great question', 'as an ai language model',
    'as a large language model', 'as of my last update', 'do not hesitate', "don't hesitate", 'don’t hesitate', 'kindly',
    'valued customer', 'please be advised', 'at your earliest convenience', 'we value your feedback',
    'your satisfaction is our priority', 'should you require any assistance', 'we look forward to serving you',
  ],
  vi: [
    'liền mạch', 'giải pháp toàn diện', 'đột phá', 'vượt trội',
    { label: 'hàng đầu', re: /(?<![\p{L}])(?<!(khách|mặt|ngân|cửa|đơn|nhà|giao|lô|kho|xếp|ưu tiên|định|dòng|cột|ở|trên|nhẹ) )hàng đầu(?! tiên)(?![\p{L}])/iu }, 'tối ưu nhất', 'trong thế giới ngày nay',
    'trong bối cảnh hiện nay', 'trong kỷ nguyên số', 'hãy cùng khám phá', 'hãy cùng tìm hiểu', 'đóng vai trò quan trọng',
    'đóng vai trò then chốt',
    { label: 'một cách + adjective', re: /(?<=\p{L}[,]? )(?<!(là|có|cần|tìm|thêm|với|một|những|mỗi|cùng) )một cách (an toàn|nhanh chóng|dễ dàng|hiệu quả|tự động|chính xác|rõ ràng|lịch sự|thông minh|liền mạch|đơn giản|nhanh|chủ động|linh hoạt|tối ưu|toàn diện|minh bạch|bảo mật|ổn định|trực quan|thuận tiện|tiện lợi|đầy đủ|chi tiết|cẩn thận|nhất quán|riêng tư|tự nhiên|hoàn hảo|liên tục|công bằng|trơn tru|chuyên nghiệp|hợp lý|triệt để|nghiêm túc|mạnh mẽ|sáng tạo|thủ công|có hệ thống|rõ rệt|đáng kể)(?![\p{L}])(?!\s+(để|cho|mà|khác))/iu },
    'quý khách', 'xin vui lòng', 'đừng ngần ngại', 'nâng tầm', 'mở khoá tiềm năng',
    'mở khóa tiềm năng', 'hy vọng điều này', 'câu hỏi hay', 'là một mô hình ngôn ngữ',
  ],
  ja: [
    'シームレス', '包括的な', '革新的な', '画期的な', 'いかがでしたか', 'と言えるでしょう', '深掘り',
    'さまざまな側面', 'お役に立てれば幸いです', '素晴らしい質問', 'AI言語モデルとして', '言語モデルとして',
  ],
  ko: [
    '혁신적인', '획기적인', '심층적으로', '알아보겠습니다', '도움이 되셨기를 바랍니다',
    '좋은 질문', 'AI 언어 모델로서', '언어 모델로서', '하는 것이 가능합니다', '주저하지 마시고', '주저하지 말고', '다양한 측면',
    '을(를)', '(으)로', '고객님께서는',
  ],
  zh: [
    '赋能', '无缝', '全方位', '一站式', '值得注意的是', '总而言之', '综上所述', '在当今', '飞速发展', '深入探讨',
    '希望这对你有帮助', '希望对您有所帮助', '希望对你有所帮助', '好问题', '作为AI语言模型', '作为一个AI语言模型',
    '作为人工智能语言模型', '颠覆性', '极致体验', '尊敬的客户', '敬请谅解',
    // Traditional Chinese (zh-TW, zh-Hant) forms of the same tells.
    '賦能', '無縫', '值得注意的是', '總而言之', '綜上所述', '在當今', '飛速發展', '深入探討', '希望對您有所幫助',
    '希望對你有所幫助', '好問題', '作為AI語言模型', '顛覆性', '極致體驗', '尊敬的客戶', '敬請諒解',
  ],
  hi: [
    'निर्बाध', 'अत्याधुनिक', 'सशक्त बनाना', 'सशक्त बनाएं', 'सशक्त बनाता', 'यह ध्यान देने योग्य है', 'आज के तेज़ी से बदलते',
    'मुझे आशा है कि इससे', 'आशा है यह मददगार', 'AI भाषा मॉडल के रूप में', 'आपकी राय हमारे लिए महत्वपूर्ण है',
    'हम हमेशा आपकी मदद के लिए तैयार हैं', 'खुशखबरी!', 'बेझिझक', 'एक बार फिर धन्यवाद', 'क्रांतिकारी',
  ],
  ru: [
    'бесшовн*', 'инновационн*', 'комплексное решение', 'важно отметить', 'стоит отметить', 'в современном мире',
    'в эпоху цифров*', 'погрузимся', 'давайте разберёмся', 'давайте разберемся', 'надеюсь, это поможет', 'отличный вопрос',
    'как языковая модель', 'уважаемый клиент', 'ваше мнение важно для нас', 'не стесняйтесь',
    { label: 'является ключевым', re: /(?<![\p{L}])является ключев(ым|ой|ыми)(?![\p{L}])(?!\s+слов)/iu },
    'играет ключевую роль', 'играет важную роль', 'осуществить', 'осуществляется',
    { label: 'данный', re: /(?<![\p{L}])данн(ый|ая|ое|ого|ой|ом|ую)(?![\p{L}])(?!\s+момент)/iu },
  ],
}

// Dash tells. English and most languages: two or more em dashes in one string (an em-dash chain; the Japanese and Chinese
// double dash —— counts as one). rules/no-ai-characters.md bans even a single em dash in English text; its own lint
// checks that. Vietnamese: any spaced em dash (a comma or a new sentence is native). Chinese: a spaced single em dash (English punctuation; Chinese uses ——).
// Russian is exempt: its dash is native punctuation.
const CHAIN = { re: /—+[^—]+—+/u, label: 'em-dash chain' }
export const DASH_RULES = {
  en: CHAIN, ja: CHAIN, ko: CHAIN, hi: CHAIN,
  vi: { re: /\s—\s|—+[^—]+—+/u, label: 'em dash in Vietnamese' },
  zh: { re: /(^|[^—])\s—\s(?!—)/u, label: 'spaced em dash in Chinese' },
}

export const LANGS = Object.keys(PHRASES)
const TAG_RE = /^(en|vi|ja|ko|zh|hi|ru)(?:[-_](?:[A-Za-z]{2}|Hans|Hant|Latn|Cyrl|\d{3}))*$/i
// Languages this check has no list for: their files and blocks are skipped instead of being read as English.
const OTHER_TAG_RE = /^(ar|de|es|fr|it|pt|th|tr|id|ms|nl|pl|sv|da|fi|no|nb|nn|he|fa|ur|el|uk|cs|sk|ro|hu|bg|hr|sr|sl|lt|lv|et|bn|ta|te|pa|gu|mr|kn|ml|km|lo|my|tl|fil|sw|zu|am|ne|si|ka|hy|az|kk|uz|mn|ca|eu|gl|cy|ga|is|mt|sq|mk|be|ps|ku|ckb|yi)(?:[-_](?:[A-Za-z]{2}|Hans|Hant|Latn|Cyrl|Arab|\d{3}))*$/i
const DIR_RE = /^(locales?|i18n|lang|langs|messages|translations?|l10n)$/i
const EXT_RE = /\.(json|ts|js|mjs|cjs)$/i
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', 'coverage', '.next', '.nuxt', '.svelte-kit',
  '.wrangler', '.turbo', 'vendor', '.claude', '.cache', 'tmp', '.output'])
const TEST_RE = /(\.test\.|\.spec\.|(^|[\\/])(__tests__|tests?|fixtures?|e2e)[\\/])/i
// Legal text is never checked: a path or key segment whose first word is one of these (termsOfService, privacy.title,
// legal/en.json), but not words that merely contain them (photos, autosave, searchTerms, passwordPolicy).
const LEGAL_WORDS = new Set(['legal', 'terms', 'privacy', 'licence', 'license', 'licenses', 'licences', 'gdpr', 'tos', 'eula',
  'disclaimer', 'disclaimers', 'consent', 'cookies', 'dpa', 'imprint', 'impressum'])

export function isLegal(s) {
  // Identifier segments only: a sentence used as a key ("Your privacy matters") is text, not a legal section.
  return String(s).split(/[\\/._-]+/).filter((seg) => !/\s/.test(seg)).some((seg) => {
    const first = seg.split(/(?<=[a-z])(?=[A-Z])/)[0].toLowerCase()
    return LEGAL_WORDS.has(first)
  })
}

/** The language tag a file or folder name stands for ('vi', 'other' for a language with no list), else null. */
export function tagOf(name) {
  const base = name.replace(EXT_RE, '')
  for (const cand of [base, base.split('.').pop()]) {
    if (TAG_RE.test(cand)) return cand.slice(0, 2).toLowerCase()
    if (OTHER_TAG_RE.test(cand)) return 'other'
  }
  return null
}

/** The language of a locale file from its name or the folder right under the locale folder, else null. */
export function langOfPath(rel) {
  const parts = rel.split(/[\\/]/)
  const own = tagOf(parts[parts.length - 1])
  if (own) return own
  for (let i = 0; i < parts.length - 2; i++) if (DIR_RE.test(parts[i])) {
    const t = tagOf(parts[i + 1])
    if (t) return t
  }
  return null
}

export function isLocaleFile(rel) {
  if (!EXT_RE.test(rel) || TEST_RE.test(rel) || /\.d\.ts$/i.test(rel) || /^(scripts|tools|bin)\//.test(rel)) return false
  if (!rel.split(/[\\/]/).slice(0, -1).some((p) => DIR_RE.test(p))) return false
  return langOfPath(rel) !== 'other'
}

export function langOfText(s) {
  if (/[가-힯]/.test(s)) return 'ko'
  if (/[぀-ヿ]/.test(s)) return 'ja'
  if (/[ऀ-ॿ]/.test(s)) return 'hi'
  if (/[Ѐ-ӿ]/.test(s)) return 'ru'
  if (/[一-鿿]/.test(s)) return 'zh'
  // Letters only Vietnamese uses (French and Portuguese share â ê ô à é).
  if (/[ăđơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i.test(s)) return 'vi'
  if (/[A-Za-z]/.test(s)) return 'en'
  return null
}

const esc = (s) => s.replace(/[.*+?^$\u007B}()|[\]\\]/g, '\\$&')
const MATCHERS = {}
export function matchersFor(lang) {
  if (MATCHERS[lang]) return MATCHERS[lang]
  MATCHERS[lang] = (PHRASES[lang] || []).map((p) => {
    if (p && p.re) return { phrase: p.label, re: p.re }
    const prefix = p.endsWith('*')
    const body = (prefix ? p.slice(0, -1) : p).normalize('NFC')
    const wordy = body.trim() === body && /^[\p{Script=Latin}\p{Script=Cyrillic}\d'’ ,-]+$/u.test(body)
    const src = wordy ? '(?<![\\p{L}\\p{N}])' + esc(body) + (prefix ? '' : '(?![\\p{L}\\p{N}])') : esc(body)
    return { phrase: p, re: new RegExp(src, 'iu') }
  })
  return MATCHERS[lang]
}

export function findTells(text, lang) {
  // Simple placeholders ({name}, {{ name }}) and tags are not words; ICU plural bodies are kept.
  const plain = String(text).normalize('NFC').replace(/\{\{?\s*[\w.$-]+\s*\}?\}/g, ' ').replace(/<[^>]+>/g, ' ')
  const hits = matchersFor(lang).filter((m) => m.re.test(plain)).map((m) => m.phrase)
  if (DASH_RULES[lang] && DASH_RULES[lang].re.test(plain)) hits.push(DASH_RULES[lang].label)
  return hits
}

function walkJson(v, keyPath, out) {
  if (typeof v === 'string') out.push({ key: keyPath.join('.'), text: v })
  else if (Array.isArray(v)) v.forEach((x, i) => walkJson(x, [...keyPath, String(i)], out))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walkJson(x, [...keyPath, k], out)
}

// A line that opens a block: a top-level declaration (const vi = {, export const zhHans: Catalog = {, export default {) or an
// object key (en: {, 'zh-CN': {). A declaration whose name is not a language resets the block language.
const DECL_RE = /^(?:export\s+)?(?:(?:const|let|var)\s+([A-Za-z_$][\w$]*)|default\b)/
const KEY_RE = /^\s*['"]?([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,4})?)['"]?\s*:\s*[{([]/
const SCRIPT_LANGS = new Set(['ko', 'ja', 'hi', 'ru', 'zh'])

/** The language a declared name stands for (vi, zhHans, zh_CN, extraEn, messagesJa); 'other' for another language; else null. */
export function tagOfName(name) {
  const direct = tagOf(name)
  if (direct) return direct
  const m = /^(?:[a-z][a-z0-9]*)?(En|Vi|Ja|Ko|Zh|Hi|Ru)(?:Hans|Hant|[A-Z]{2}|[A-Z][a-z]{1,3})?$/.exec(name) || /^(en|vi|ja|ko|zh|hi|ru)(?:Hans|Hant|[A-Z]{2}|[A-Z][a-z]{1,3})$/.exec(name)
  return m ? m[1].toLowerCase() : null
}

/** Strings of a source file (JSON parsed; JS/TS by a literal scan), each with a key path and, where known, a block language. */
export function stringsOf(rel, src) {
  const out = []
  if (/\.json$/i.test(rel)) {
    try { walkJson(JSON.parse(src), [], out) } catch { return out }
    for (const s of out) {
      const segs = s.key.split('.').slice(0, -1)
      for (const k of segs) { const t = tagOf(k); if (t) { s.lang = t; break } }
    }
    return out
  }
  let block = null
  src.split(/\r?\n/).forEach((line, i) => {
    const d = DECL_RE.exec(line)
    if (d) block = d[1] ? tagOfName(d[1]) : null
    else { const k = KEY_RE.exec(line); if (k) { const t = tagOfName(k[1]); if (t) block = t } }
    if (/^\s*(\/\/|\*|\/\*|import\s|export\s+(type|interface)\s)/.test(line)) return
    const key = (/^\s*['"]?([\w.$-]+)['"]?\s*:/.exec(line) || [])[1] || 'line'
    for (const m of line.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|\x60((?:[^\x60\\$]|\\.|\$(?!\u007B))*)\x60/g)) {
      const text = m[1] ?? m[2] ?? m[3]
      if (!text) continue
      const before = line.slice(0, m.index)
      const valuePos = /[:=]\s*$|\(\s*$|,\s*$|\[\s*$|\?\s*$/.test(before)
      const sentence = /\p{L}{2,}\s+\p{L}|[぀-ヿ一-鿿가-힯ऀ-ॿ]/u.test(text)
      const word = valuePos && /^\p{Lu}\p{L}{3,}[.!?]?$/u.test(text)
      if (!sentence && !word) continue
      out.push({ key: key + ' (line ' + (i + 1) + ')', text, lang: block })
    }
  })
  return out
}

export class UsageError extends Error {}

function readAllow(root) {
  const f = path.join(root, '.ai-tells-allow.json')
  if (!fs.existsSync(f)) return []
  let j
  try { j = JSON.parse(fs.readFileSync(f, 'utf8')) } catch (e) { throw new UsageError('.ai-tells-allow.json is not valid JSON: ' + e.message) }
  const allow = Array.isArray(j.allow) ? j.allow : null
  if (!allow) throw new UsageError('.ai-tells-allow.json needs an "allow" array')
  for (const a of allow) if (!a || !a.reason || !a.phrase) throw new UsageError('.ai-tells-allow.json: every entry needs a phrase and a reason')
  return allow
}

export function listFiles(root) {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new UsageError('no such folder: ' + root)
  const out = []
  const walk = (dir) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name)); continue }
      const rel = path.relative(root, path.join(dir, e.name)).split(path.sep).join('/')
      if (isLocaleFile(rel) && !isLegal(rel)) out.push(rel)
    }
  }
  walk(root)
  return out.sort()
}

export function check(root) {
  const allow = readAllow(root)
  const findings = []
  const files = listFiles(root)
  for (const rel of files) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8')
    const fileLang = langOfPath(rel)
    for (const s of stringsOf(rel, src)) {
      if (isLegal(s.key)) continue
      const byScript = langOfText(s.text)
      let lang = fileLang || s.lang || byScript
      // Text in another script than its block's language is read by its script (a zh string after a vi block).
      if (SCRIPT_LANGS.has(byScript) && byScript !== lang && !(lang === 'ja' && byScript === 'zh')) lang = byScript
      if (!lang || lang === 'other') continue
      for (const phrase of findTells(s.text, lang)) {
        if (allow.some((a) => (!a.path || rel.includes(a.path)) && (!a.key || s.key.includes(a.key)) && a.phrase.toLowerCase() === phrase.toLowerCase())) continue
        findings.push({ file: rel, key: s.key, lang, phrase, text: s.text.length > 140 ? s.text.slice(0, 137) + '...' : s.text })
      }
    }
  }
  findings.files = files.length
  return findings
}

export function main(argv, write = (s) => process.stdout.write(s), warn = (s) => process.stderr.write(s)) {
  const flags = argv.filter((a) => a.startsWith('--'))
  const roots = argv.filter((a) => !a.startsWith('--'))
  if (flags.some((f) => !['--json', '--files'].includes(f))) { warn('usage: check-ai-tells.mjs [root ...] [--json] [--files]\n'); return 2 }
  try {
    if (flags.includes('--files')) { for (const root of roots.length ? roots : ['.']) for (const f of listFiles(root)) write(f + '\n'); return 0 }
    let all = []
    let files = 0
    for (const root of roots.length ? roots : ['.']) { const found = check(root); files += found.files; all = all.concat(found) }
    if (!files) warn('check-ai-tells: no locale files found (a folder named locales, i18n, lang, messages or translations)\n')
    if (flags.includes('--json')) write(JSON.stringify(all, null, 2) + '\n')
    else {
      for (const f of all) write(f.file + ' ' + f.key + ' [' + f.lang + '] "' + f.phrase + '": ' + f.text + '\n')
      write(all.length ? all.length + ' AI or translation tell(s) in ' + files + ' locale file(s). Rewrite them natively (avoid-ai-writing skill), or allow one with a reason in .ai-tells-allow.json.\n' : 'check-ai-tells: clean (' + files + ' locale file(s))\n')
    }
    return all.length ? 1 : 0
  } catch (e) {
    if (e instanceof UsageError) { warn('check-ai-tells: ' + e.message + '\n'); return 2 }
    throw e
  }
}

const isMain = () => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)) } catch { return false } }
if (process.argv[1] && isMain()) process.exitCode = main(process.argv.slice(2))
