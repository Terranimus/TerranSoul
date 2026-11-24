# AI tells and translation tells in our seven languages

Terranimus addition to the vendored avoid-ai-writing skill (not upstream). Upstream says its rules "are calibrated for
English; applying them to another language requires language-specific rules and evidence". This file is that part for
the seven app languages (`en vi ja ko zh hi ru`, Memo 424171). Read it with `references/patterns.md` before you write or
review user-facing text in any of them.

Two kinds of tell, in every language:

1. **AI tells**: what a model writes when nobody stops it. Stock vocabulary (the local "seamless", "robust",
   "cutting-edge"), chatbot artifacts ("I hope this helps"), significance inflation, rule-of-three padding, em-dash chains,
   a closing summary that repeats the screen.
2. **Translation tells**: correct words in English structure. Passive voice where the language prefers an actor,
   nominalisation, a literal "you", English punctuation, stacked clauses, idioms carried over word for word.

The voice for each language (address, register, particles, emoji, punctuation) is in
`multilingual-native-copy/references/language-notes.md`. Vietnamese has its own doctrine in `vietnamese-writing`; run its
checker too. This file lists the tells only. The guard `scripts/check-ai-tells.mjs` checks the clear-cut ones (marked
**guard** below) in every i18n catalog; the rest need a reader.

## How to fix a tell

- Rewrite from what the string must do for the reader (confirm, warn, invite, explain), as a native would say it. Do not
  swap one stock word for its synonym.
- Keep the facts: numbers, names, placeholders, links, product terms and the strength of any promise. Never touch legal
  text in a style pass.
- Fix one language without changing the others' meaning. If the English source itself is the problem, fix it first, then
  check each translation still says the same thing.
- A word on the list can be right (a literal "robust" in an engineering spec, "最先端のモデル" for frontier models). Keep it
  and add an `.ai-tells-allow.json` entry with the reason.

## en

- **guard**: avoid-ai-writing Tier 1A words (delve, tapestry, testament to, robust, comprehensive, seamless, leverage,
  pivotal, meticulous, cutting-edge, game-changer, holistic, actionable, impactful, learnings, synergy, world-class,
  state-of-the-art, best-in-class) and chatbot artifacts ("I hope this helps", "Great question", "As an AI language model").
- **guard**: stock service lines: "do not hesitate", "kindly", "valued customer", "please be advised", "at your earliest
  convenience", "we value your feedback", "your satisfaction is our priority".
- **guard**: an em-dash chain (two or more em dashes in one string). `rules/no-ai-characters.md` bans even one em dash in
  English text and its lint checks that; use commas, a colon or two sentences.
- Reader: "not just X, but Y"; "It's not X, it's Y"; "Whether you're A or B"; "unlock / elevate / empower / supercharge";
  rule of three ("fast, simple and secure") when only one is true; a closing line that restates the heading.

| Before | After |
| --- | --- |
| Seamlessly sync your notes across devices with our robust engine. | Your notes sync to every device you sign in on. |
| `Don't hesitate to reach out — we're here to help!` | Questions? Reply to this email. |

## vi

- **guard**: any spaced em dash (`" — "`); "một cách" + adjective; "liền mạch", "giải pháp toàn diện", "đột phá", "vượt trội",
  "hàng đầu" (as "leading"), "tối ưu nhất", "nâng tầm", "trong thế giới ngày nay", "trong bối cảnh hiện nay", "hãy cùng
  khám phá", "đóng vai trò quan trọng", "quý khách", "xin vui lòng", "đừng ngần ngại".
- Reader (the `vietnamese-writing` calque list): passive "được/bị" where an actor exists, "sự/việc/tính" nominalisation,
  superfluous "của", "rằng", "điều này", "nó", sentences over 25 words, a pronoun pair that changes mid-text, chat slang.

| Before | After |
| --- | --- |
| `Dữ liệu của bạn được đồng bộ một cách liền mạch — trên mọi thiết bị.` | Dữ liệu tự đồng bộ trên mọi thiết bị bạn đăng nhập. |
| Xin vui lòng đừng ngần ngại liên hệ với chúng tôi. | Cần gì cứ trả lời email này nhé. |

## ja

- **guard**: シームレス, 包括的な, 革新的な, 画期的な, いかがでしたか, と言えるでしょう, 深掘り, さまざまな側面,
  お役に立てれば幸いです, 素晴らしい質問, 言語モデルとして, and an em-dash chain (the native double dash `——` counts as
  one dash, so a single `——` passes).
- Reader: させていただきます used everywhere, 何卒 and ことが重要です piled up (each is fine alone); あなた for "you"; お客様 as a stand-in pronoun; 〜されました for the business's own act (say 確定しました);
  stacked honorifics; katakana for words Japanese already has (ソリューション, エクスペリエンス); a お知らせ label where a
  sentence states the news; English punctuation (half-width ! ?, ":" mid-sentence) and `—` where Japanese uses 、 or （）.

| Before | After |
| --- | --- |
| シームレスなエクスペリエンスを提供させていただきます。 | どの端末からでも、続きからすぐ使えます。 |

## ko

- **guard**: 혁신적인, 획기적인, 심층적으로, 알아보겠습니다, 도움이 되셨기를 바랍니다, 좋은 질문, AI로서,
  하는 것이 가능합니다, 주저하지 마시고, 다양한 측면, the slash particles 을(를) and (으)로 (rephrase so one particle fits, or
  drop it after a placeholder), 고객님께서는, and an em-dash chain.
- Reader: 원활한 stacked with other stock adjectives (alone, "원활한 이용을 위해" is ordinary UI Korean); 당신; passive system
  verbs (발송되었습니다); ~에 대해, ~을 통해, ~을 진행하겠습니다; -습니다 creeping into a 해요체 paragraph; 띄어쓰기 on
  auxiliary verbs.

| Before | After |
| --- | --- |
| {app}을(를) 원활하게 사용하는 것이 가능합니다. | 이제 {app} 앱을 바로 쓸 수 있어요. |

## zh

- **guard**: 赋能, 无缝, 全方位, 一站式, 值得注意的是, 总而言之, 综上所述, 在当今, 飞速发展, 深入探讨, 希望对您有所帮助,
  好问题, 作为AI语言模型, 颠覆性, 极致体验, 尊敬的客户, 敬请谅解 (敬请期待 is fine), the same in Traditional characters
  (賦能, 無縫, 總而言之 ...), and a spaced single em dash (`" — "`; Chinese uses `——`).
- Reader: 进行 + verb (`进行设置` becomes `设置`); `对于……来说`; 被 for the business's own act; 您 mixed with 你; `非常感谢您的……`; long
  modifiers before a noun (的的的); half-width punctuation; 打造 / 助力 / 引领 marketing verbs; Simplified and Traditional mixed.

| Before | After |
| --- | --- |
| 我们致力于为企业赋能，打造一站式无缝体验。 | 账号、会议和文件，在一个地方就能管好。 |

## hi

- **guard**: निर्बाध, अत्याधुनिक, सशक्त बनाना/बनाएं, यह ध्यान देने योग्य है, आज के तेज़ी से बदलते, मुझे आशा है कि इससे,
  एक AI के रूप में, आपकी राय हमारे लिए महत्वपूर्ण है, हम हमेशा आपकी मदद के लिए तैयार हैं, खुशखबरी!, बेझिझक, एक बार फिर
  धन्यवाद, क्रांतिकारी, and an em-dash chain.
- Reader: the Sanskritised form register (प्रतिक्रिया, साझा करें, सूचित, प्रतीक्षा, "की जा चुकी है") where people say
  फ़ीडबैक or राय, शेयर, बताना, इंतज़ार; verbs that reveal the reader's gender; English word order (verb before object); तुम;
  inconsistent nukta spellings.

| Before | After |
| --- | --- |
| हमारा अत्याधुनिक प्लेटफ़ॉर्म आपको निर्बाध अनुभव प्रदान करता है। | आप जिस भी डिवाइस पर साइन इन करें, आपका काम वहीं मिलेगा। |

## ru

- **guard**: бесшовный (any ending), инновационный (any ending), комплексное решение, важно отметить, стоит отметить,
  в современном мире, `в эпоху цифровых...`, погрузимся, давайте разберёмся, надеюсь, это поможет, отличный вопрос,
  как языковая модель, уважаемый клиент, ваше мнение важно для нас, не стесняйтесь, является ключевым (not "ключевым
  словом"), играет ключевую/важную роль, осуществить, осуществляется, данный/данная/данное (not "на данный момент" or "данные").
- Reader: канцелярит (в целях, в рамках, производится, является + noun); stacked genitives; passive where «мы» acts;
  capital «Вы» in the interface; Latin quotes `"..."` instead of «ёлочки». The em dash is native in Russian and is
  not a tell by itself. House style, not a tell: always write «ё».

| Before | After |
| --- | --- |
| Данный сервис является ключевым инструментом для осуществления бесшовной синхронизации. | Сервис сам синхронизирует заметки на всех ваших устройствах. |
