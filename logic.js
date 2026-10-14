/* Чистая логика мини-приложения: без DOM, поэтому её можно проверять тестом
   в Node (см. _tmp/proverka-mini-app.cjs). В браузере доступна как OSET_LOGIC. */
;(function (root) {
  'use strict'

  // Расписание повторения: интервалы по «коробкам» в днях.
  const INTERVALS_DAYS = [0, 1, 3, 7, 21, 60]
  const AGAIN_MS = 10 * 60 * 1000 // «не знаю» — вернуть карточку через 10 минут

  function parseClock(text) {
    const m = /^(\d+):(\d{2})$/.exec(String(text).trim())
    if (!m) return null
    return Number(m[1]) * 60 + Number(m[2])
  }

  /** «0:35–1:05» → длительность шага в минутах (30). */
  function stepDuration(range) {
    const parts = String(range).split('–')
    if (parts.length !== 2) return 0
    const from = parseClock(parts[0])
    const to = parseClock(parts[1])
    if (from === null || to === null || to <= from) return 0
    return to - from
  }

  function blockMinutes(steps) {
    return (steps || []).reduce((sum, s) => sum + stepDuration(s[0]), 0)
  }

  function stepName(what) {
    const text = String(what)
    if (/^разогрев/i.test(text)) return 'Разогрев'
    if (/^аудирование/i.test(text)) return 'Аудирование'
    if (/^(запись|говорение)/i.test(text)) return 'Говорение на запись'
    if (/^разбор|^итогов/i.test(text)) return 'Разбор'
    if (/^слушать|^читать|^разобрать/i.test(text)) return 'Новое ядро'
    return 'Практика'
  }

  function fmtClock(ms) {
    const total = Math.max(0, Math.round(ms / 1000))
    const h = Math.floor(total / 3600)
    const m = Math.floor((total % 3600) / 60)
    const s = total % 60
    const pad = (n) => String(n).padStart(2, '0')
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
  }

  function fmtHuman(minutes) {
    const total = Math.max(0, Math.round(minutes))
    const h = Math.floor(total / 60)
    const m = total % 60
    if (h === 0) return `${m} мин`
    if (m === 0) return `${h} ч`
    return `${h} ч ${m} мин`
  }

  /** Следующее состояние карточки. know=true — «знаю», false — «не знаю». */
  function srsNext(box, know, now) {
    const time = now ?? Date.now()
    if (!know) return { box: 0, due: time + AGAIN_MS }
    const next = Math.min((box ?? 0) + 1, INTERVALS_DAYS.length - 1)
    const days = INTERVALS_DAYS[next]
    return { box: next, due: time + days * 24 * 60 * 60 * 1000 }
  }

  function cardKey(card) {
    return `${card.deck}|${card.front}`
  }

  function dayKey(ts) {
    const d = new Date(ts)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  /** Серия дней подряд, включая сегодня или вчера. */
  function streak(days, today) {
    const set = new Set(days || [])
    const start = today ? new Date(today) : new Date()
    const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate())
    if (!set.has(dayKey(cursor.getTime()))) {
      cursor.setDate(cursor.getDate() - 1)
      if (!set.has(dayKey(cursor.getTime()))) return 0
    }
    let count = 0
    while (set.has(dayKey(cursor.getTime()))) {
      count += 1
      cursor.setDate(cursor.getDate() - 1)
    }
    return count
  }

  function totals(state) {
    const sessions = state?.sessions || []
    const minutes = sessions.reduce((sum, s) => sum + (Number(s.min) || 0), 0)
    const blocks = state?.blocks || {}
    let done = 0
    for (const key of Object.keys(blocks)) {
      if (blocks[key]?.done) done += 1
    }
    const cards = state?.cards || {}
    let seen = 0
    let learned = 0
    for (const key of Object.keys(cards)) {
      const c = cards[key]
      if (c?.seen) seen += 1
      if ((c?.box || 0) >= 3) learned += 1
    }
    const days = new Set(sessions.map((s) => dayKey(s.ts)))
    for (const key of Object.keys(cards)) {
      const last = cards[key]?.last
      if (last) days.add(dayKey(last))
    }
    return {
      minutes,
      hours: Math.round((minutes / 60) * 10) / 10,
      sessions: sessions.length,
      blocksDone: done,
      cardsSeen: seen,
      cardsLearned: learned,
      streak: streak([...days]),
      days: [...days].sort(),
    }
  }

  /** Очередь карточек: сначала просроченные, потом новые (с дневным лимитом). */
  function pickQueue(allCards, state, now, newLimit) {
    const time = now ?? Date.now()
    const store = state?.cards || {}
    const today = dayKey(time)
    const usedNew = state?.cardsDay?.date === today ? state.cardsDay.newDone || 0 : 0
    const allowNew = Math.max(0, (newLimit ?? 12) - usedNew)
    const due = []
    const fresh = []
    for (const card of allCards) {
      const rec = store[cardKey(card)]
      if (!rec || !rec.seen) fresh.push(card)
      else if ((rec.due || 0) <= time) due.push({ card, due: rec.due || 0 })
    }
    due.sort((a, b) => a.due - b.due)
    return {
      queue: [...due.map((d) => d.card), ...fresh.slice(0, allowNew)],
      dueCount: due.length,
      newCount: fresh.length,
      allowNew,
    }
  }

  /** Проверка целостности данных — используется тестом и кнопкой «Проверить». */
  function validateData(data) {
    const problems = []
    if (!data) return ['нет данных']
    if (!Array.isArray(data.blocks) || data.blocks.length !== 10) {
      problems.push(`блоков должно быть 10, а их ${data.blocks ? data.blocks.length : 0}`)
    }
    const expected = { 1: 120, 2: 120, 3: 120, 4: 120, 5: 120, 6: 120, 7: 120, 8: 120, 9: 120, 10: 120 }
    for (const block of data.blocks || []) {
      if (blockMinutes(block.steps) !== expected[block.n]) {
        problems.push(`блок ${block.n}: тайминг даёт ${blockMinutes(block.steps)} мин вместо 120`)
      }
      if (!block.goal) problems.push(`блок ${block.n}: нет цели`)
      if (!block.checklist?.length) problems.push(`блок ${block.n}: пустой чек-лист`)
      if ((block.conclusions || []).length !== 5) problems.push(`блок ${block.n}: выводов ${(block.conclusions || []).length}, а надо 5`)
      if (!block.steps?.length) problems.push(`блок ${block.n}: нет тайминга`)
      if (!block.sources?.length) problems.push(`блок ${block.n}: нет источников`)
    }
    const keys = new Set()
    for (const card of data.cards || []) {
      const key = cardKey(card)
      if (keys.has(key)) problems.push(`дубль карточки: ${key}`)
      keys.add(key)
      if (!card.deck || !card.front || !card.back) problems.push(`карточка без поля: ${JSON.stringify(card)}`)
    }
    if (!(data.cards || []).length) problems.push('нет карточек')
    if (!(data.cheat || []).length) problems.push('нет шпаргалки')
    if (!(data.sources || []).length) problems.push('нет источников')
    return problems
  }

  /**
   * Чистка текста для озвучки: знаки препинания в звук не попадают, поэтому
   * файл ищется по очищенному тексту. Одна и та же функция используется
   * приложением, инструментом озвучки (ozvuchka\sobrat-slova.cjs) и тестами —
   * иначе текст карточки и текст в списке озвучки перестанут совпадать.
   */
  function ochistitTekst(tekst) {
    return String(tekst || '')
      .replace(/[·•]/g, ' – ')
      .replace(/[^А-Яа-яӕӔÆæЁё\-– ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  /** Ключ для поиска озвучки: тот же текст, но без учёта регистра. */
  function klyuchZvuka(tekst) {
    return ochistitTekst(tekst).toLowerCase()
  }

  // Слова, по которым видно, что строка — объяснение по-русски, а не фраза курса.
  const RUSSKIE_SLOVA = new Set([
    'буква', 'буквы', 'букв', 'звук', 'звуки', 'слово', 'слова', 'слог', 'ударение',
    'похоже', 'значит', 'например', 'важно', 'важнее', 'чисто', 'сама', 'сам', 'это',
    'как', 'чем', 'или', 'если', 'когда', 'который', 'которая', 'которые', 'делает',
    'делают', 'читается', 'читают', 'произнести', 'произносится', 'соседнюю', 'плюс',
    'русские', 'русский', 'задержкой', 'лёгким', 'щелчком', 'гортанные', 'глухое',
    'придыханием', 'картавое', 'французское', 'английское', 'между', 'не', 'и', 'в',
    'на', 'с', 'для', 'то', 'же', 'но', 'а', 'у', 'о', 'по', 'из', 'к', 'за', 'от',
    // русские вопросительные и служебные слова из пояснений
    'куда', 'где', 'кто', 'что', 'чей', 'чья', 'чьё', 'чьи', 'сколько', 'какой',
    'какая', 'какие', 'зачем', 'почему', 'откуда', 'котором', 'которой', 'только',
    'вместо', 'вопрос', 'вопросы', 'ответ', 'просьба', 'приказ', 'прошедшее',
    'настоящее', 'будущее', 'время', 'форма', 'формы', 'окончание', 'окончания',
    'старшему', 'старший', 'благодарность', 'новости', 'песни', 'радиопередачи', 'цель',
  ])

  /**
   * Достаёт осетинские фразы из строки курса вида
   * «Дæ бон хорз! / Уæ бон хорз! — добрый день (тебе / вам).»
   * Возвращает список фраз: ['Дæ бон хорз!', 'Уæ бон хорз!'].
   * Строки-объяснения (без тире или с русскими словами) пропускаются.
   */
  function frazyIzStroki(tekst) {
    const stroka = String(tekst || '').trim()
    const tire = stroka.split(/\s+[—–]\s+/)
    if (tire.length < 2) return []

    const levo = tire[0].trim()
    if (!levo || levo.length > 90) return []
    if (/[a-zA-Z]{2,}/.test(levo)) return [] // латиница — это пояснение, а не фраза

    const chasti = levo.split(/\s*[/,]\s*/).map((s) => s.trim()).filter(Boolean)
    const frazy = []
    for (const chast of chasti) {
      // шаблоны с многоточием («Мæн ис … азы») и склейки со знаками +/= не озвучиваем
      if (/…|\+|=/u.test(chast)) continue
      const ochishchennaya = ochistitTekst(chast)
      if (ochishchennaya.length < 2 || ochishchennaya.length > 40) continue
      const slova = ochishchennaya.toLowerCase().split(' ')
      if (slova.length > 6) continue
      if (slova.some((s) => RUSSKIE_SLOVA.has(s))) continue
      // в осетинской фразе почти всегда есть буква, которой нет в русском алфавите
      if (!/[ӕæгъхъкъджпътъцъчъ]/i.test(ochishchennaya) && slova.length > 1) continue
      frazy.push(chast)
    }
    return frazy
  }

  // Буквы, которых нет в словаре модели озвучки Meta MMS: они пришли в осетинский
  // алфавит из русского для заимствованных слов. Их озвучки не будет — приложение
  // показывает это честно, а не молчит.
  const BUKVY_BEZ_OZVUCHKI = new Set(['Ё', 'Ш', 'Щ', 'Ь', 'Я'])

  const api = {
    INTERVALS_DAYS,
    AGAIN_MS,
    parseClock,
    stepDuration,
    blockMinutes,
    stepName,
    fmtClock,
    fmtHuman,
    srsNext,
    cardKey,
    dayKey,
    streak,
    totals,
    pickQueue,
    validateData,
    ochistitTekst,
    klyuchZvuka,
    frazyIzStroki,
    BUKVY_BEZ_OZVUCHKI,
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api
  root.OSET_LOGIC = api
})(typeof globalThis !== 'undefined' ? globalThis : this)
