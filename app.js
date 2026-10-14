/* Мини-приложение «Осетинский за 20 часов».
   Работает офлайн: всё внутри страницы, данные — в localStorage телефона.
   Если открыть внутри Telegram — подхватывает тему, кнопку «назад» и вибро-отклик. */
;(function () {
  'use strict'

  const L = window.OSET_LOGIC
  const DATA = window.OSET_DATA
  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null

  const STORE_KEY = 'oset20h.v1'
  const TAB_HASH = { blocks: '#/blocks', timer: '#/timer', cards: '#/cards', sheet: '#/sheet', progress: '#/progress' }

  // ------------------------------------------------------------------ хранилище
  const memory = {}
  const storage = {
    read(key) {
      try {
        return window.localStorage.getItem(key)
      } catch {
        return memory[key] ?? null
      }
    },
    write(key, value) {
      try {
        window.localStorage.setItem(key, value)
      } catch {
        memory[key] = value
      }
    },
  }

  function defaultState() {
    const blocks = {}
    for (const block of DATA.blocks) {
      blocks[block.n] = { done: false, checks: [], concl: [], notes: '', words: '', decision: '' }
    }
    return {
      v: 1,
      sessions: [],
      blocks,
      cards: {},
      cardsDay: { date: '', newDone: 0 },
      settings: { dir: 'os-ru', newPerDay: 12, lastBlock: 1 },
      timer: null,
    }
  }

  function loadState() {
    const raw = storage.read(STORE_KEY)
    if (!raw) return defaultState()
    try {
      const parsed = JSON.parse(raw)
      const base = defaultState()
      return {
        ...base,
        ...parsed,
        blocks: { ...base.blocks, ...(parsed.blocks || {}) },
        settings: { ...base.settings, ...(parsed.settings || {}) },
      }
    } catch {
      return defaultState()
    }
  }

  let state = loadState()
  let saveSoon = null
  function save() {
    if (saveSoon) clearTimeout(saveSoon)
    saveSoon = setTimeout(() => {
      saveSoon = null
      storage.write(STORE_KEY, JSON.stringify(state))
    }, 250)
  }

  // ------------------------------------------------------------------ утилиты
  function h(tag, props, children) {
    const node = document.createElement(tag)
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined || value === false) continue
        if (key === 'class') node.className = value
        else if (key === 'text') node.textContent = value
        else if (key === 'html') node.innerHTML = value
        else if (key === 'style') node.setAttribute('style', value)
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value)
        else node.setAttribute(key, value === true ? '' : String(value))
      }
    }
    for (const child of [].concat(children || [])) {
      if (child === null || child === undefined || child === false) continue
      node.append(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child)
    }
    return node
  }

  const $ = (sel, where) => (where || document).querySelector(sel)

  function haptic(kind) {
    try {
      if (tg && tg.HapticFeedback) {
        if (kind === 'ok') tg.HapticFeedback.notificationOccurred('success')
        else if (kind === 'warn') tg.HapticFeedback.notificationOccurred('warning')
        else tg.HapticFeedback.impactOccurred(kind || 'light')
      }
    } catch {}
  }

  function buzz(pattern) {
    try {
      if (navigator.vibrate) navigator.vibrate(pattern || 60)
    } catch {}
  }

  let audioCtx = null
  function beep(times) {    try {
      const Ctx = window.AudioContext || window.webkitAudioContext
      if (!Ctx) return
      audioCtx = audioCtx || new Ctx()
      const count = times || 2
      for (let i = 0; i < count; i += 1) {
        const at = audioCtx.currentTime + i * 0.28
        const osc = audioCtx.createOscillator()
        const gain = audioCtx.createGain()
        osc.type = 'sine'
        osc.frequency.value = i % 2 === 0 ? 880 : 660
        gain.gain.setValueAtTime(0.0001, at)
        gain.gain.exponentialRampToValueAtTime(0.25, at + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.22)
        osc.connect(gain).connect(audioCtx.destination)
        osc.start(at)
        osc.stop(at + 0.25)
      }
    } catch {}
  }

  // ------------------------------------------------------------------ озвучка слов
  // Рядом с приложением лежит папка audio: mp3 на каждое слово курса и список
  // audio/spisok.json вида [{ tekst, fayl }]. Озвучка синтезирована локально
  // моделью Meta MMS для осетинского языка (CC-BY-NC 4.0).
  let zvuki = null // карта «текст слова → файл»
  let zvukiNet = false // озвучки нет (не загрузилась) — кнопки не показываем
  let pleer = null // один проигрыватель на всё приложение (см. poluchitPleer)
  let podryad = null // состояние прослушивания подряд: { fayly, nomer, stop }

  // Чистка текста и ключ для поиска озвучки лежат в logic.js (L.klyuchZvuka) —
  // одна и та же функция используется приложением, инструментом озвучки и тестами.
  async function zagruzitZvuki() {
    if (zvuki || zvukiNet) return zvuki
    try {
      const otvet = await fetch('audio/spisok.json', { cache: 'no-store' })
      if (!otvet.ok) throw new Error(String(otvet.status))
      const dannye = await otvet.json()
      const karta = new Map()
      for (const f of dannye.faily || []) {
        const klyuch = L.klyuchZvuka(f && f.tekst)
        if (klyuch && f.fayl) karta.set(klyuch, `audio/${f.fayl}`)
      }
      if (!karta.size) throw new Error('пусто')
      zvuki = karta
      render() // кнопки появляются, как только список доехал
    } catch {
      zvukiNet = true
    }
    return zvuki
  }

  function faylZvuka(tekst) {
    if (!zvuki) return null
    return zvuki.get(L.klyuchZvuka(tekst)) || null
  }

  function ostanovitZvuk() {
    try {
      if (pleer) pleer.pause()
    } catch {}
    if (podryad) podryad.stop = true
    podryad = null
  }

  // Один и тот же проигрыватель на всё приложение: на iPhone Safari разрешает
  // продолжать звук только тому элементу, который «разбужен» нажатием. Если каждый
  // раз создавать новый Audio, режим «прослушать подряд» обрывается после первого слова.
  function poluchitPleer() {
    if (!pleer) {
      try {
        pleer = new Audio()
        pleer.preload = 'auto'
      } catch {
        return null
      }
    }
    return pleer
  }

  function vklyuchit(fayl, naOkonchanie) {
    const igrushka = poluchitPleer()
    if (!igrushka) {
      toast('В этом браузере звук недоступен', 'warn')
      return false
    }
    try {
      igrushka.onended = naOkonchanie || null
      igrushka.src = fayl
      const start = igrushka.play()
      if (start && start.catch) {
        start.catch(() => toast('Звук не включился: проверьте громкость телефона и разрешение на звук', 'warn'))
      }
      return true
    } catch {
      toast('В этом браузере звук недоступен', 'warn')
      return false
    }
  }

  function igrat(tekst) {
    const fayl = faylZvuka(tekst)
    if (!fayl) {
      toast('Для этого слова озвучки нет', 'warn')
      return
    }
    ostanovitZvuk()
    vklyuchit(fayl)
  }

  // Проиграть список слов подряд — упражнение «слушать и повторять вслух».
  function igratPodryad(teksty, knopka) {
    if (podryad) {
      ostanovitZvuk()
      if (knopka) knopka.textContent = '▶️ Прослушать все слова подряд'
      return
    }
    const faily = teksty.map(faylZvuka).filter(Boolean)
    if (!faily.length) {
      toast('Озвучка ещё не загрузилась', 'warn')
      return
    }
    const sostoyanie = { fayly: faily, nomer: 0, stop: false }
    podryad = sostoyanie
    const sleduyushchee = () => {
      if (sostoyanie.stop) return
      if (sostoyanie.nomer >= faily.length) {
        podryad = null
        if (knopka) knopka.textContent = '▶️ Прослушать все слова подряд'
        toast('Прослушали все слова', 'ok')
        return
      }
      sostoyanie.nomer += 1
      if (knopka) knopka.textContent = `⏸ Слушаем ${sostoyanie.nomer} из ${faily.length} — нажмите, чтобы остановить`
      if (!vklyuchit(faily[sostoyanie.nomer - 1], sleduyushchee)) sostoyanie.stop = true
    }
    sleduyushchee()
  }

  // Кнопка «послушать»; если озвучки для слова нет — возвращает null.
  function knopkaZvuka(tekst, opts) {
    const nastroyki = opts || {}
    if (!faylZvuka(tekst)) return null
    return h('button', {
      class: nastroyki.class || 'btn small',
      text: nastroyki.text || '🔊 Послушать',
      title: tekst,
      onclick: (e) => {
        e.stopPropagation()
        igrat(tekst)
        buzz(20)
      },
    })
  }

  // Осетинские фразы, спрятанные в строке курса («Дæ бон хорз! / Уæ бон хорз! — добрый день»).
  // Разбор делает та же функция, что и в инструменте озвучки: ozvuchka\sobrat-slova.cjs.
  function frazySoZvukom(tekst) {
    if (!zvuki) return []
    return L.frazyIzStroki(tekst).filter((f) => faylZvuka(f))
  }

  // Ряд кнопок «послушать» под строкой курса.
  function ryadFraza(tekst) {
    const frazy = frazySoZvukom(tekst)
    if (!frazy.length) return null
    return h('div', { class: 'row wrap' }, frazy.map((fraza) =>
      h('button', {
        class: 'btn small',
        text: `🔊 ${fraza}`,
        onclick: (e) => {
          e.stopPropagation()
          igrat(fraza)
        },
      }),
    ))
  }

  // Весь озвученный материал блока: фразы из ядра (алфавит добавляется отдельно).
  function materialBloka(block) {
    const frazy = []
    const uzhe = new Set()
    for (const sekciya of block.core || []) {
      for (const punkt of sekciya.items || []) {
        if (typeof punkt !== 'string') continue
        for (const fraza of L.frazyIzStroki(punkt)) {
          const klyuch = L.klyuchZvuka(fraza)
          if (!faylZvuka(fraza) || uzhe.has(klyuch)) continue
          uzhe.add(klyuch)
          frazy.push(fraza)
        }
      }
    }
    return frazy
  }

  // Блок «слушать и повторять»: кнопки всех фраз по порядку и прослушивание подряд.
  function blokSlushaniya(block) {
    const frazy = materialBloka(block)
    const bukvy = (block.n === 1 ? DATA.alphabet : []).filter((b) => faylZvuka(b))
    const bezZvuka = (block.n === 1 ? DATA.alphabet : []).filter((b) => !faylZvuka(b))

    if (!zvuki) {
      return h('div', { class: 'cardbox' }, [
        h('h2', { text: 'Слушать и повторять' }),
        h('p', { class: 'muted small', text: zvukiNet
          ? 'Озвучка не загрузилась — проверьте интернет и обновите страницу.'
          : 'Озвучка загружается…' }),
      ])
    }

    return h('div', { class: 'cardbox' }, [
      h('h2', { text: 'Слушать и повторять' }),
      h('p', { class: 'muted small', text: 'Нажмите слово — услышите произношение. Слушайте и повторяйте вслух: это и есть шаг «аудирование».' }),

      bukvy.length
        ? h('div', {}, [
            h('h3', { text: 'Алфавит, 43 буквы' }),
            h('div', { class: 'row wrap' }, bukvy.map((b) =>
              h('button', { class: 'chip', text: b, onclick: (e) => { e.stopPropagation(); igrat(b) } }),
            )),
            h('button', {
              class: 'btn ghost wide',
              text: '▶️ Прослушать весь алфавит подряд',
              onclick: (e) => igratPodryad(bukvy, e.currentTarget),
            }),
            bezZvuka.length
              ? h('p', { class: 'muted small', text: `Без озвучки (этих букв нет в модели): ${bezZvuka.join(', ')}` })
              : null,
          ])
        : null,

      frazy.length
        ? h('div', {}, [
            h('h3', { text: 'Фразы блока' }),
            h('div', { class: 'row wrap' }, frazy.map((f) =>
              h('button', { class: 'btn small', text: `🔊 ${f}`, onclick: (e) => { e.stopPropagation(); igrat(f) } }),
            )),
            h('button', {
              class: 'btn ghost wide',
              text: `▶️ Прослушать все фразы блока (${frazy.length})`,
              onclick: (e) => igratPodryad(frazy, e.currentTarget),
            }),
          ])
        : null,

      h('p', { class: 'muted small', text: 'Живые записи носителей (диалоги, новости) — по ссылкам в «Источниках блока»: их синтезом не заменить.' }),
    ])
  }

  function toast(text, kind) {
    const box = $('#toast')
    box.textContent = text
    box.className = `toast show ${kind || ''}`
    clearTimeout(toast._id)
    toast._id = setTimeout(() => {
      box.className = 'toast'
    }, 2600)
  }

  function confirmBox(text, onYes) {
    const wrap = h('div', { class: 'modal' }, [
      h('div', { class: 'modal-box' }, [
        h('p', { text }),
        h('div', { class: 'row' }, [
          h('button', { class: 'btn ghost', text: 'Отмена', onclick: () => wrap.remove() }),
          h('button', {
            class: 'btn danger',
            text: 'Да',
            onclick: () => {
              wrap.remove()
              onYes()
            },
          }),
        ]),
      ]),
    ])
    document.body.append(wrap)
  }

  const blockOf = (n) => DATA.blocks.find((b) => b.n === Number(n)) || DATA.blocks[0]
  const bstate = (n) => {
    const key = String(n)
    if (!state.blocks[key]) state.blocks[key] = { done: false, checks: [], concl: [], notes: '', words: '', decision: '' }
    if (!Array.isArray(state.blocks[key].checks)) state.blocks[key].checks = []
    if (!Array.isArray(state.blocks[key].concl)) state.blocks[key].concl = []
    return state.blocks[key]
  }

  function blockPercent(n) {
    const block = blockOf(n)
    const st = bstate(n)
    const total = block.checklist.length + block.conclusions.length
    const done =
      block.checklist.filter((_, i) => st.checks[i]).length + block.conclusions.filter((_, i) => st.concl[i]).length
    return total === 0 ? 0 : Math.round((done / total) * 100)
  }

  // ------------------------------------------------------------------ таймер
  function stepInfo(index) {
    const timer = state.timer
    if (!timer) return null
    const block = blockOf(timer.block)
    if (index < 0 || index >= block.steps.length) return null
    const [range, what] = block.steps[index]
    return { range, what, name: L.stepName(what), minutes: L.stepDuration(range) }
  }

  function timerTotals() {
    if (!state.timer) return null
    const block = blockOf(state.timer.block)
    const doneMin = block.steps.slice(0, state.timer.index).reduce((s, st) => s + L.stepDuration(st[0]), 0)
    const current = L.stepDuration(block.steps[state.timer.index]?.[0] || '0:00')
    const elapsed = doneMin + Math.min(state.timer.spent, current)
    return { total: L.blockMinutes(block.steps), elapsed, current }
  }

  function tick() {
    const timer = state.timer
    if (!timer || !timer.running) return
    const now = Date.now()
    const deltaMin = (now - (timer.lastTick || now)) / 60000
    timer.lastTick = now
    timer.spent += deltaMin
    const block = blockOf(timer.block)
    let guard = 0
    while (guard < 20) {
      guard += 1
      const info = stepInfo(timer.index)
      if (!info) break
      if (timer.spent < info.minutes) break
      timer.spent -= info.minutes
      timer.index += 1
      if (timer.index >= block.steps.length) {
        finishTimer(true)
        return
      }
      beep(3)
      buzz([120, 80, 120])
      haptic('ok')
      toast(`Шаг ${timer.index + 1}: ${stepInfo(timer.index).name}`, 'ok')
      if (location.hash.startsWith('#/timer')) render()
    }
    save()
    updateTimerDigits()
  }

  /** Плавное обновление цифр таймера — без перерисовки всей страницы. */
  function updateTimerDigits() {
    if (!state.timer) return
    const info = stepInfo(state.timer.index)
    if (!info) return
    const totals = timerTotals()
    const remain = Math.max(0, info.minutes - state.timer.spent)
    const set = (id, text) => {
      const el = document.getElementById(id)
      if (el) el.textContent = text
    }
    set('t-remain', L.fmtClock(remain * 60000))
    set('t-pill', L.fmtClock(remain * 60000))
    const percent = Math.min(100, Math.round((totals.elapsed / totals.total) * 100))
    const bar = document.getElementById('t-bar')
    if (bar) bar.style.width = `${percent}%`
    set('t-total', `всего ${L.fmtHuman(totals.elapsed)} из ${L.fmtHuman(totals.total)} (${percent}%)`)
  }

  function finishTimer(complete) {
    const timer = state.timer
    if (!timer) return
    const totals = timerTotals()
    const minutes = Math.max(1, Math.round(totals ? totals.elapsed : 0))
    const block = blockOf(timer.block)
    const stepNow = timer.index
    state.sessions.push({ ts: Date.now(), min: minutes, block: block.n })
    state.settings.lastBlock = block.n
    state.timer = null
    save()
    beep(complete ? 3 : 1)
    buzz(complete ? [200, 100, 200] : 80)
    haptic(complete ? 'ok' : 'light')
    toast(
      complete
        ? `Все шаги блока ${block.n} пройдены: записано ${L.fmtHuman(minutes)}`
        : `Записано ${L.fmtHuman(minutes)} (остановились на шаге ${stepNow + 1})`,
      'ok',
    )
    render()
  }

  function startTimer(blockN) {
    const block = blockOf(blockN)
    state.timer = { block: block.n, index: 0, spent: 0, running: true, lastTick: Date.now() }
    state.settings.lastBlock = block.n
    save()
    beep(1)
    haptic('light')
    location.hash = '#/timer'
    render()
  }

  // ------------------------------------------------------------------ карточки
  let cardSession = null

  function deckNames() {
    const names = []
    for (const card of DATA.cards) if (!names.includes(card.deck)) names.push(card.deck)
    return names
  }

  function cardStats() {
    const now = Date.now()
    const picked = L.pickQueue(DATA.cards, state, now, state.settings.newPerDay)
    let learned = 0
    for (const card of DATA.cards) {
      const rec = state.cards[L.cardKey(card)]
      if (rec && (rec.box || 0) >= 3) learned += 1
    }
    return { ...picked, learned, total: DATA.cards.length }
  }

  function startCards(mode) {
    const stats = cardStats()
    let queue = stats.queue
    if (mode === 'new') {
      queue = DATA.cards.filter((c) => !state.cards[L.cardKey(c)]?.seen).slice(0, state.settings.newPerDay)
    }
    if (mode === 'due') queue = queue.filter((c) => state.cards[L.cardKey(c)]?.seen)
    if (queue.length === 0) {
      toast('На сегодня повторять нечего — приходите завтра', 'ok')
      return
    }
    cardSession = { queue, index: 0, flipped: false, right: 0, wrong: 0 }
    render()
  }

  function answerCard(know) {
    if (!cardSession) return
    const card = cardSession.queue[cardSession.index]
    const key = L.cardKey(card)
    const rec = state.cards[key] || { box: 0, seen: 0, ok: 0, fail: 0 }
    const next = L.srsNext(rec.box || 0, know, Date.now())
    const isNew = !rec.seen
    state.cards[key] = {
      box: next.box,
      due: next.due,
      seen: (rec.seen || 0) + 1,
      ok: (rec.ok || 0) + (know ? 1 : 0),
      fail: (rec.fail || 0) + (know ? 0 : 1),
      last: Date.now(),
    }
    if (isNew) {
      const today = L.dayKey(Date.now())
      if (state.cardsDay.date !== today) state.cardsDay = { date: today, newDone: 0 }
      state.cardsDay.newDone += 1
    }
    if (know) cardSession.right += 1
    else cardSession.wrong += 1
    cardSession.index += 1
    cardSession.flipped = false
    haptic(know ? 'light' : 'warn')
    save()
    if (cardSession.index >= cardSession.queue.length) {
      const right = cardSession.right
      const wrong = cardSession.wrong
      cardSession = null
      beep(2)
      toast(`Повторение закончено: знаю ${right}, не знаю ${wrong}`, 'ok')
    }
    render()
  }

  // ------------------------------------------------------------------ экраны
  function viewBlocks() {
    const totals = L.totals(state)
    const wrap = h('section', {}, [
      h('div', { class: 'hero' }, [
        h('h1', { text: DATA.title }),
        h('p', { class: 'muted', text: DATA.subtitle }),
        h('div', { class: 'stats' }, [
          h('div', { class: 'stat' }, [h('b', { text: String(totals.hours) }), h('span', { text: 'часов' })]),
          h('div', { class: 'stat' }, [h('b', { text: `${totals.blocksDone}/10` }), h('span', { text: 'блоков' })]),
          h('div', { class: 'stat' }, [h('b', { text: String(totals.streak) }), h('span', { text: 'дней подряд' })]),
        ]),
      ]),
      h('div', { class: 'note' }, [
        h('b', { text: 'Правило дня: ' }),
        h('span', { text: 'каждый блок заканчивается речью вслух. Не записали себя на диктофон — блок не закрыт.' }),
      ]),
      // Учебный материал (слова и правила) лежит в отдельных разделах. Кнопки здесь —
      // чтобы до него можно было дойти прямо с первого экрана, а не только через нижнюю панель.
      h('div', { class: 'row' }, [
        h('button', {
          class: 'btn grow',
          text: `🃏 Карточки слов (${DATA.cards.length})`,
          onclick: () => (location.hash = '#/cards'),
        }),
        h('button', {
          class: 'btn grow',
          text: '📋 Шпаргалка и правила',
          onclick: () => (location.hash = '#/sheet'),
        }),
      ]),
      h('div', { class: 'list' }, DATA.blocks.map((block) => {
        const percent = blockPercent(block.n)
        const done = bstate(block.n).done
        return h('button', { class: 'block-row', onclick: () => (location.hash = `#/block/${block.n}`) }, [
          h('div', { class: `num ${done ? 'done' : ''}`, text: done ? '✓' : String(block.n) }),
          h('div', { class: 'grow' }, [
            h('div', { class: 'title', text: block.title }),
            h('div', { class: 'muted small', text: block.gives }),
            h('div', { class: 'bar' }, [h('i', { style: `width:${percent}%` })]),
          ]),
          h('div', { class: 'percent', text: `${percent}%` }),
        ])
      })),
      h('button', { class: 'btn primary wide', text: 'Продолжить: блок ' + state.settings.lastBlock, onclick: () => startTimer(state.settings.lastBlock) }),
    ])
    return wrap
  }

  function viewBlock(n) {
    const block = blockOf(n)
    const st = bstate(block.n)
    const key = String(block.n)
    const percent = blockPercent(block.n)
    const refreshPercent = () => {
      const el = document.getElementById('b-percent')
      if (el) el.textContent = `готовность ${blockPercent(block.n)}%`
    }

    const core = block.core.map((section) =>
      h('details', { class: 'acc' }, [
        h('summary', { text: section.h }),
        h('ul', { class: 'list-plain' }, section.items.map((item) =>
          h('li', {}, [h('span', { text: item }), ryadFraza(item)]),
        )),
      ]),
    )

    const steps = h('div', { class: 'steps' }, block.steps.map(([range, what], i) =>
      h('div', { class: 'step' }, [
        h('span', { class: 'time', text: range }),
        h('div', { class: 'grow' }, [
          h('div', { class: 'step-name', text: L.stepName(what) }),
          h('div', { class: 'muted small', text: what }),
        ]),
        h('span', { class: 'pill', text: `${L.stepDuration(range)} мин` }),
      ]),
    ))

    const conclusions = block.conclusions.map((text, i) =>
      h('label', { class: `check ${st.concl[i] ? 'on' : ''}` }, [
        h('input', {
          type: 'checkbox',
          checked: st.concl[i] ? true : null,
          onchange: (e) => {
            st.concl[i] = e.target.checked
            e.target.closest('.check').classList.toggle('on', e.target.checked)
            refreshPercent()
            save()
          },
        }),
        h('span', { text }),
      ]),
    )

    const checklist = block.checklist.map((text, i) =>
      h('label', { class: `check ${st.checks[i] ? 'on' : ''}` }, [
        h('input', {
          type: 'checkbox',
          checked: st.checks[i] ? true : null,
          onchange: (e) => {
            st.checks[i] = e.target.checked
            e.target.closest('.check').classList.toggle('on', e.target.checked)
            refreshPercent()
            save()
          },
        }),
        h('span', { text }),
      ]),
    )

    return h('section', {}, [
      h('button', { class: 'btn ghost small', text: '← все блоки', onclick: () => (location.hash = '#/blocks') }),
      h('h1', { text: `Блок ${block.n}. ${block.title}` }),
      h('div', { class: 'row wrap' }, [
        h('span', { class: 'badge', text: '2 часа' }),
        h('span', { class: 'badge', text: block.gives }),
        h('span', { class: 'badge', id: 'b-percent', text: `готовность ${percent}%` }),
        st.done ? h('span', { class: 'badge ok', text: 'блок закрыт' }) : null,
      ]),
      h('p', { class: 'lead' }, [h('b', { text: 'Цель: ' }), block.goal]),

      h('button', { class: 'btn primary wide', text: `Запустить блок ${block.n} по таймеру (2 ч)`, onclick: () => startTimer(block.n) }),

      h('h2', { text: 'Ядро блока: 20%, которое даёт 80%' }),
      ...core,

      blokSlushaniya(block),

      block.proverit ? h('div', { class: 'warn' }, [h('b', { text: 'Проверить у носителя. ' }), block.proverit]) : null,

      h('h2', { text: 'Тайминг блока' }),
      steps,

      h('h2', { text: 'Практика между блоками' }),
      h('ul', { class: 'list-plain' }, block.practice.map((p) => h('li', { text: p }))),

      h('h2', { text: 'Разбор, 15 минут' }),
      h('p', { class: 'muted small', text: 'Отметьте выводы, которые подтвердились по вашей записи, и заполните разбор — он сохраняется в телефоне.' }),
      ...conclusions,
      h('h3', { text: 'Чек-лист «умею»' }),
      ...checklist,
      h('h3', { text: 'Мои заметки к разбору' }),
      h('textarea', {
        class: 'area',
        rows: 3,
        placeholder: 'Что получилось, что нет; где запнулся на записи',
        oninput: (e) => {
          st.notes = e.target.value
          save()
        },
      }, st.notes ? [st.notes] : []),
      h('textarea', {
        class: 'area',
        rows: 2,
        placeholder: '10 слов и 5 фраз — в карточки',
        oninput: (e) => {
          st.words = e.target.value
          save()
        },
      }, st.words ? [st.words] : []),
      h('textarea', {
        class: 'area',
        rows: 2,
        placeholder: 'Одно решение: что делаю иначе в следующем блоке',
        oninput: (e) => {
          st.decision = e.target.value
          save()
        },
      }, st.decision ? [st.decision] : []),

      h('h2', { text: 'Источники блока' }),
      h('ul', { class: 'list-plain links' }, block.sources.map((s) =>
        h('li', {}, [h('a', { href: s.url, target: '_blank', rel: 'noreferrer', text: s.label })]),
      )),

      h('div', { class: 'row' }, [
        h('button', {
          class: `btn ${st.done ? 'ghost' : 'primary'} grow`,
          text: st.done ? 'Снять отметку «блок закрыт»' : 'Отметить блок закрытым',
          onclick: () => {
            state.blocks[key].done = !st.done
            save()
            haptic('ok')
            render()
          },
        }),
        h('button', {
          class: 'btn ghost',
          text: 'Записать сессию вручную',
          onclick: () => {
            state.sessions.push({ ts: Date.now(), min: 120, block: block.n })
            save()
            toast('Записано 2 часа', 'ok')
            render()
          },
        }),
      ]),
    ])
  }

  function viewTimer() {
    const block = blockOf(state.timer ? state.timer.block : state.settings.lastBlock)
    const chips = h('div', { class: 'chips' }, DATA.blocks.map((b) =>
      h('button', {
        class: `chip ${b.n === block.n ? 'on' : ''}`,
        text: String(b.n),
        onclick: () => {
          state.settings.lastBlock = b.n
          if (state.timer) state.timer = null
          save()
          render()
        },
      }),
    ))

    if (!state.timer) {
      return h('section', {}, [
        h('h1', { text: 'Таймер блока' }),
        h('p', { class: 'muted', text: 'Выберите блок — таймер проведёт по шести шагам двухчасового занятия и запишет время в прогресс.' }),
        chips,
        h('div', { class: 'cardbox' }, [
          h('div', { class: 'title', text: `Блок ${block.n}. ${block.title}` }),
          h('div', { class: 'muted small', text: block.gives }),
        ]),
        h('div', { class: 'steps' }, block.steps.map(([range, what]) =>
          h('div', { class: 'step' }, [
            h('span', { class: 'time', text: range }),
            h('div', { class: 'grow' }, [
              h('div', { class: 'step-name', text: L.stepName(what) }),
              h('div', { class: 'muted small', text: what }),
            ]),
          ]),
        )),
        h('button', { class: 'btn primary wide', text: 'Начать занятие (2 часа)', onclick: () => startTimer(block.n) }),
        totalsHint(),
      ])
    }

    const timer = state.timer
    const info = stepInfo(timer.index)
    const totals = timerTotals()
    const remainingStep = Math.max(0, info.minutes - timer.spent)
    const percent = Math.round((totals.elapsed / totals.total) * 100)

    const list = h('div', { class: 'steps' }, block.steps.map(([range, what], i) => {
      const cls = i < timer.index ? 'step done' : i === timer.index ? 'step on' : 'step'
      return h('div', { class: cls }, [
        h('span', { class: 'time', text: range }),
        h('div', { class: 'grow' }, [
          h('div', { class: 'step-name', text: L.stepName(what) }),
          h('div', { class: 'muted small', text: what }),
        ]),
        i === timer.index ? h('span', { class: 'pill on', id: 't-pill', text: L.fmtClock(remainingStep * 60000) }) : null,
      ])
    }))

    return h('section', {}, [
      h('h1', { text: `Блок ${block.n}: занятие идёт` }),
      chips,
      h('div', { class: 'cardbox center' }, [
        h('div', { class: 'muted small', text: `Шаг ${timer.index + 1} из ${block.steps.length} · ${info.range}` }),
        h('div', { class: 'big', id: 't-remain', text: L.fmtClock(remainingStep * 60000) }),
        h('div', { class: 'step-name', text: info.name }),
        h('p', { text: info.what }),
        h('div', { class: 'bar big-bar' }, [h('i', { id: 't-bar', style: `width:${percent}%` })]),
        h('div', { class: 'muted small', id: 't-total', text: `всего ${L.fmtHuman(totals.elapsed)} из ${L.fmtHuman(totals.total)} (${percent}%)` }),
      ]),
      h('div', { class: 'row' }, [
        h('button', {
          class: 'btn primary grow',
          text: timer.running ? '⏸ Пауза' : '▶ Продолжить',
          onclick: () => {
            timer.running = !timer.running
            timer.lastTick = Date.now()
            save()
            haptic('light')
            render()
          },
        }),
        h('button', {
          class: 'btn ghost',
          text: 'Шаг →',
          onclick: () => {
            timer.spent = 0
            timer.index += 1
            timer.lastTick = Date.now()
            if (timer.index >= block.steps.length) return finishTimer(true)
            save()
            render()
          },
        }),
      ]),
      h('div', { class: 'row' }, [
        h('button', {
          class: 'btn ghost grow',
          text: 'Закончить и записать время',          onclick: () => confirmBox('Закончить занятие и записать пройденное время в прогресс?', () => finishTimer(false)),
        }),
        h('button', {
          class: 'btn ghost',
          text: 'Сбросить',
          onclick: () => confirmBox('Сбросить таймер без записи времени?', () => {
            state.timer = null
            save()
            render()
          }),
        }),
      ]),
      blokSlushaniya(block),
      list,
    ])
  }

  function totalsHint() {
    const totals = L.totals(state)
    return h('p', { class: 'muted small', text: `Всего записано: ${L.fmtHuman(totals.minutes)} за ${totals.sessions} занятий.` })
  }

  function viewCards() {
    if (cardSession) return viewCardSession()
    const stats = cardStats()
    const decks = deckNames()
    const dir = state.settings.dir
    const learnedPercent = Math.round((stats.learned / stats.total) * 100)

    return h('section', {}, [
      h('h1', { text: 'Карточки' }),
      h('p', { class: 'muted', text: 'Повторение по схеме: сразу → через день → 3 дня → неделю → месяц. Карточка = слово + фраза с ним.' }),
      h('div', { class: 'stats' }, [
        h('div', { class: 'stat' }, [h('b', { text: String(stats.dueCount) }), h('span', { text: 'к повторению' })]),
        h('div', { class: 'stat' }, [h('b', { text: String(stats.newCount) }), h('span', { text: 'новых' })]),
        h('div', { class: 'stat' }, [h('b', { text: `${stats.learned}/${stats.total}` }), h('span', { text: 'выучено' })]),
      ]),
      h('div', { class: 'bar big-bar' }, [h('i', { style: `width:${learnedPercent}%` })]),
      h('button', {
        class: 'btn primary wide',
        text: stats.dueCount > 0 ? `Повторить просроченные (${stats.dueCount})` : 'Повторение: сегодня всё сделано',
        onclick: () => startCards('due'),
      }),
      h('button', {
        class: 'btn ghost wide',
        text: `Учить новые (${Math.min(stats.allowNew, stats.newCount)} из лимита ${state.settings.newPerDay})`,
        onclick: () => startCards('new'),
      }),
      h('button', { class: 'btn ghost wide', text: `Смешанная сессия (${stats.queue.length})`, onclick: () => startCards('mix') }),

      h('h2', { text: 'Настройки повторения' }),
      h('div', { class: 'row' }, [
        h('label', { class: 'field grow' }, [
          h('span', { text: 'Новых слов в день' }),
          h('input', {
            type: 'number',
            min: 5,
            max: 40,
            value: state.settings.newPerDay,
            onchange: (e) => {
              state.settings.newPerDay = Math.max(5, Math.min(40, Number(e.target.value) || 12))
              save()
              render()
            },
          }),
        ]),
        h('label', { class: 'field grow' }, [
          h('span', { text: 'Направление' }),
          h('select', {
            onchange: (e) => {
              state.settings.dir = e.target.value
              save()
            },
          }, [
            h('option', { value: 'os-ru', text: 'осетинский → русский', selected: dir === 'os-ru' ? true : null }),
            h('option', { value: 'ru-os', text: 'русский → осетинский', selected: dir === 'ru-os' ? true : null }),
          ]),
        ]),
      ]),

      h('h2', { text: 'Колоды' }),
      h('div', { class: 'chips' }, decks.map((deck) => {
        const total = DATA.cards.filter((c) => c.deck === deck).length
        const learned = DATA.cards.filter((c) => c.deck === deck && (state.cards[L.cardKey(c)]?.box || 0) >= 3).length
        return h('span', { class: 'chip plain', text: `${deck} · ${learned}/${total}` })
      })),
      h('p', { class: 'muted small', text: 'Карточки с пометкой «проверить у носителя» показывают плашку на обороте.' }),

      // --- слушание: то самое упражнение «слушать и повторять вслух»
      h('h2', { text: 'Слушать слова' }),
      h('p', { class: 'muted small', text: zvuki
        ? 'Нажмите на слово — услышите произношение. Слушайте и повторяйте вслух: это и есть работа на слух.'
        : zvukiNet
          ? 'Озвучка не загрузилась. Проверьте интернет и обновите страницу — файлы лежат рядом с приложением в папке audio.'
          : 'Озвучка загружается…' }),
      zvuki
        ? h('button', {
            class: 'btn ghost wide',
            text: '▶️ Прослушать все слова подряд',
            onclick: (e) => igratPodryad(DATA.cards.map((c) => c.front), e.currentTarget),
          })
        : null,
      zvuki
        ? h('div', {}, decks.map((deck) =>
            h('details', { class: 'acc' }, [
              h('summary', { text: `${deck} · ${DATA.cards.filter((c) => c.deck === deck).length} слов` }),
              h('ul', { class: 'list-plain' }, DATA.cards.filter((c) => c.deck === deck).map((c) =>
                h('li', {}, [
                  h('button', {
                    class: 'linklike',
                    text: `🔊 ${c.front}`,
                    onclick: (e) => { e.preventDefault(); igrat(c.front) },
                  }),
                  h('span', { class: 'muted small', text: ` — ${c.back}` }),
                ]),
              )),
            ]),
          ))
        : null,
    ])
  }

  function viewCardSession() {
    const card = cardSession.queue[cardSession.index]
    const dir = state.settings.dir
    const front = dir === 'os-ru' ? card.front : card.back
    const back = dir === 'os-ru' ? card.back : card.front
    const left = cardSession.queue.length - cardSession.index

    const cardBox = h('div', {
      class: 'flash',
      onclick: () => {
        if (cardSession.flipped) return
        cardSession.flipped = true
        haptic('light')
        render()
      },
    }, [
      h('div', { class: 'deck small muted', text: card.deck }),
      h('div', { class: 'word', text: front }),
      // Осетинскую сторону слушаем всегда; в направлении «рус → осет» кнопка
      // появляется только после переворота, иначе она подсказывала бы ответ.
      dir === 'os-ru' || cardSession.flipped
        ? knopkaZvuka(card.front, { class: 'btn ghost small', text: '🔊 Послушать слово' })
        : null,
      cardSession.flipped
        ? h('div', { class: 'answer' }, [
            h('div', { class: 'word2', text: back }),
            card.proverit ? h('div', { class: 'warn small' }, [h('b', { text: 'Проверить у носителя: ' }), 'форма в программе помечена как требующая проверки.']) : null,
          ])
        : h('div', { class: 'muted small', text: 'нажмите, чтобы увидеть перевод' }),
    ])

    return h('section', {}, [
      h('div', { class: 'row between' }, [
        h('span', { class: 'muted small', text: `осталось ${left}` }),
        h('span', { class: 'muted small', text: `знаю ${cardSession.right} · не знаю ${cardSession.wrong}` }),
      ]),
      cardBox,
      cardSession.flipped
        ? h('div', { class: 'row' }, [
            h('button', { class: 'btn danger grow', text: 'Не знаю', onclick: () => answerCard(false) }),
            h('button', { class: 'btn primary grow', text: 'Знаю', onclick: () => answerCard(true) }),
          ])
        : h('button', {
            class: 'btn ghost wide',
            text: 'Показать перевод',
            onclick: () => {
              cardSession.flipped = true
              render()
            },
          }),
      h('button', {
        class: 'btn ghost wide',
        text: 'Выйти из повторения',
        onclick: () => {
          cardSession = null
          render()
        },
      }),
    ])
  }

  function viewSheet() {
    const section = (title, nodes) => h('div', {}, [h('h2', { text: title })].concat(nodes || []))

    return h('section', {}, [
      h('h1', { text: 'Шпаргалка и правила' }),

      section('Три правила программы', h('ul', { class: 'list-plain' }, DATA.rules.map((r) => h('li', { text: r })))),

      section('Ядро 20%, которое даёт 80%', h('div', { class: 'list' }, DATA.core20.map((item) =>
        h('div', { class: 'cardbox' }, [
          h('div', { class: 'title', text: `${item.n}. ${item.name}` }),
          h('div', { class: 'muted small', text: item.why }),
        ]),
      ))),

      section('Чего не берём в первые 20 часов', h('ul', { class: 'list-plain' }, DATA.notNow.map((t) => h('li', { text: t })))),

      section('Шпаргалка ядра', DATA.cheat.map((group) =>
        h('div', { class: 'cardbox' }, [
          h('div', { class: 'title', text: group.h }),
          h('ul', { class: 'list-plain' }, group.items.map((i) =>
            h('li', {}, [h('span', { text: i }), ryadFraza(i)]),
          )),
        ]),
      )),

      section('Алфавит со звуком', h('div', {}, [
        h('p', { class: 'muted small', text: 'Нажмите букву — услышите, как она звучит.' }),
        zvuki
          ? h('div', { class: 'row wrap' }, DATA.alphabet.map((b) =>
              faylZvuka(b)
                ? h('button', { class: 'chip', text: b, onclick: (e) => { e.stopPropagation(); igrat(b) } })
                : h('span', { class: 'chip plain', text: `${b} — нет озвучки`, title: 'Этой буквы нет в словаре модели озвучки' }),
            ))
          : h('p', { class: 'muted small', text: zvukiNet ? 'Озвучка не загрузилась.' : 'Озвучка загружается…' }),
        zvuki
          ? h('button', {
              class: 'btn ghost wide',
              text: '▶️ Прослушать весь алфавит подряд',
              onclick: (e) => igratPodryad(DATA.alphabet.filter((b) => faylZvuka(b)), e.currentTarget),
            })
          : null,
        h('p', { class: 'muted small', text: 'Буквы Ё, Ш, Щ, Ь, Я пришли из русского алфавита для заимствованных слов; модель озвучки их не произносит.' }),
      ])),

      section('Разбор в конце блока', h('ul', { class: 'list-plain' }, DATA.review.map((r) => h('li', { text: r })))),

      section('Блок закрыт, если', h('ul', { class: 'list-plain' }, DATA.blockClosed.map((r) => h('li', { text: r })))),

      section('Как учить слова', h('ul', { class: 'list-plain' }, DATA.words.map((r) => h('li', { text: r })))),

      section('Как проверять прогресс без преподавателя', DATA.tests.map((t) =>
        h('div', { class: 'cardbox' }, [h('div', { class: 'title', text: t.name }), h('div', { class: 'muted small', text: t.how })]),
      )),

      section('Что делать после 20 часов', h('ul', { class: 'list-plain' }, DATA.after.map((r) => h('li', { text: r })))),

      section('Источники (проверенные)', [
        ...DATA.sources.map((group) =>
          h('details', { class: 'acc' }, [
            h('summary', { text: group.h }),
            h('ul', { class: 'list-plain links' }, group.items.map((item) =>
              h('li', {}, [item.url ? h('a', { href: item.url, target: '_blank', rel: 'noreferrer', text: item.label }) : h('span', { class: 'muted', text: item.label })]),
            )),
          ]),
        ),
        h('p', { class: 'note', text: DATA.minimalSet }),
      ]),
    ])
  }

  function viewProgress() {
    const totals = L.totals(state)
    const recent = [...state.sessions].reverse().slice(0, 8)

    return h('section', {}, [
      h('h1', { text: 'Прогресс' }),
      h('div', { class: 'stats' }, [
        h('div', { class: 'stat' }, [h('b', { text: String(totals.hours) }), h('span', { text: 'часов' })]),
        h('div', { class: 'stat' }, [h('b', { text: String(totals.sessions) }), h('span', { text: 'занятий' })]),
        h('div', { class: 'stat' }, [h('b', { text: `${totals.blocksDone}/10` }), h('span', { text: 'блоков' })]),
        h('div', { class: 'stat' }, [h('b', { text: String(totals.cardsLearned) }), h('span', { text: 'слов' })]),
      ]),
      h('div', { class: 'note' }, [
        h('b', { text: `Серия: ${totals.streak} дн. подряд. ` }),
        h('span', { text: '15 минут в день дают больше, чем час раз в неделю.' }),
      ]),

      h('h2', { text: 'Блоки' }),
      h('div', { class: 'list' }, DATA.blocks.map((block) => {
        const percent = blockPercent(block.n)
        const done = bstate(block.n).done
        return h('div', { class: 'block-row static' }, [
          h('div', { class: `num ${done ? 'done' : ''}`, text: done ? '✓' : String(block.n) }),
          h('div', { class: 'grow' }, [
            h('div', { class: 'title small', text: block.title }),
            h('div', { class: 'bar' }, [h('i', { style: `width:${percent}%` })]),
          ]),
          h('div', { class: 'percent', text: `${percent}%` }),
        ])
      })),

      h('h2', { text: 'Последние занятия' }),
      recent.length
        ? h('ul', { class: 'list-plain' }, recent.map((s) =>
            h('li', { text: `${new Date(s.ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} — блок ${s.block}, ${L.fmtHuman(s.min)}` }),
          ))
        : h('p', { class: 'muted small', text: 'Пока ни одного занятия. Запустите таймер блока.' }),

      h('h2', { text: 'Данные' }),
      h('p', { class: 'muted small', text: 'Прогресс хранится только в этом телефоне. Можно выгрузить файл-копию или перенести его на другое устройство.' }),
      h('div', { class: 'row' }, [
        h('button', {
          class: 'btn ghost grow',
          text: 'Выгрузить копию',
          onclick: () => {
            const text = JSON.stringify(state)
            const blob = new Blob([text], { type: 'application/json' })
            const link = h('a', { href: URL.createObjectURL(blob), download: `oset20h-progress-${L.dayKey(Date.now())}.json` })
            document.body.append(link)
            link.click()
            link.remove()
            toast('Файл с прогрессом сохранён', 'ok')
          },
        }),
        h('button', {
          class: 'btn ghost',
          text: 'Проверить данные',
          onclick: () => {
            const problems = L.validateData(DATA)
            toast(problems.length ? `Найдено ${problems.length} замечаний (см. консоль)` : 'Данные программы в порядке', problems.length ? 'warn' : 'ok')
            if (problems.length) console.warn(problems)
          },
        }),
      ]),
      h('button', {
        class: 'btn danger wide',
        text: 'Сбросить прогресс',
        onclick: () => confirmBox('Удалить весь прогресс: занятия, отметки блоков и повторения карточек?', () => {
          state = defaultState()
          cardSession = null
          save()
          toast('Прогресс сброшен')
          render()
        }),
      }),
    ])
  }

  // ------------------------------------------------------------------ отрисовка
  let currentTab = 'blocks'

  function paintHeader() {
    const el = $('#tabs')
    for (const button of el.querySelectorAll('button')) {
      button.classList.toggle('on', button.dataset.tab === currentTab)
    }
  }

  function parseHash() {
    const hash = location.hash || '#/blocks'
    let m = /^#\/block\/(\d+)/.exec(hash)
    if (m) return { name: 'block', param: Number(m[1]), tab: 'blocks' }
    m = /^#\/timer\/(\d+)/.exec(hash)
    if (m) return { name: 'timer', param: Number(m[1]), tab: 'timer' }
    const simple = hash.replace('#/', '')
    if (['blocks', 'timer', 'cards', 'sheet', 'progress'].includes(simple)) return { name: simple, tab: simple }
    return { name: 'blocks', tab: 'blocks' }
  }

  function render() {
    const route = parseHash()
    currentTab = route.tab
    const view = $('#view')
    view.replaceChildren(
      route.name === 'block' ? viewBlock(route.param)
        : route.name === 'timer' ? viewTimer()
        : route.name === 'cards' ? viewCards()
        : route.name === 'sheet' ? viewSheet()
        : route.name === 'progress' ? viewProgress()
        : viewBlocks(),
    )
    paintHeader()
    view.scrollTop = 0
    try {
      window.scrollTo(0, 0)
    } catch {}
    if (tg && tg.BackButton) {
      if (route.name === 'block' || route.name === 'timer') tg.BackButton.show()
      else tg.BackButton.hide()
    }
  }

  function buildTabs() {
    const tabs = [
      { tab: 'blocks', icon: '📚', label: 'Блоки' },
      { tab: 'timer', icon: '⏱', label: 'Таймер' },
      { tab: 'cards', icon: '🃏', label: 'Карточки' },
      { tab: 'sheet', icon: '📋', label: 'Шпаргалка' },
      { tab: 'progress', icon: '📈', label: 'Прогресс' },
    ]
    const nav = $('#tabs')
    nav.replaceChildren(...tabs.map((t) =>
      h('button', {
        class: 'tab',
        'data-tab': t.tab,
        onclick: () => {
          location.hash = TAB_HASH[t.tab]
          render()
        },
      }, [h('span', { class: 'ic', text: t.icon }), h('span', { text: t.label })]),
    ))
  }

  function applyTelegramTheme() {
    if (!tg) return
    try {
      const p = tg.themeParams || {}
      const set = (name, value) => {
        if (value) document.documentElement.style.setProperty(name, value)
      }
      // Telegram отдаёт не все цвета. Если тема светлая, сначала ставим свою светлую
      // палитру целиком: иначе тёмные части (кнопки, нижняя панель, карточка слова)
      // остаются тёмными и текст на них не читается.
      if ((tg.colorScheme || '').toLowerCase() === 'light') {
        set('--bg', '#f4f6f9')
        set('--card', '#ffffff')
        set('--card2', '#e8ecf3')
        set('--text', '#151a23')
        set('--muted', '#5c6675')
        set('--line', '#d6dbe4')
        set('--ok-text', '#0f7a44')
        set('--danger-text', '#b3261e')
        set('--word2', '#3a4453')
        set('--nav-bg', 'rgba(255, 255, 255, .96)')
      } else {
        set('--nav-bg', 'rgba(14, 17, 22, .96)')
      }
      set('--bg', p.bg_color)
      set('--card', p.secondary_bg_color)
      set('--text', p.text_color)
      set('--muted', p.hint_color)
      set('--accent', p.button_color)
      set('--accent-text', p.button_text_color)
      set('--line', p.section_separator_color)
      document.documentElement.dataset.theme = tg.colorScheme || 'dark'
    } catch {}
  }

  // Если приложение не открывалось дольше получаса, таймер сам встаёт на паузу,
  // иначе заблокированный на ночь телефон «пройдёт» блок сам.
  const AWAY_LIMIT_MS = 30 * 60 * 1000

  function pauseIfAbandoned() {
    const timer = state.timer
    if (!timer || !timer.running) return false
    const away = Date.now() - (timer.lastTick || Date.now())
    if (away <= AWAY_LIMIT_MS) return false
    timer.running = false
    timer.lastTick = Date.now()
    save()
    toast(`Таймер на паузе: приложение не открывалось ${L.fmtHuman(away / 60000)}`, 'warn')
    return true
  }

  function boot() {
    buildTabs()
    zagruzitZvuki()
    if (tg) {
      try {
        tg.ready()
        tg.expand()
        tg.BackButton?.onClick(() => history.back())
        tg.onEvent?.('themeChanged', applyTelegramTheme)
        applyTelegramTheme()
      } catch {}
    }
    pauseIfAbandoned()
    window.addEventListener('hashchange', render)
    let hiddenAt = null
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        hiddenAt = Date.now()
        return
      }
      // вернулись в приложение: время в фоне считается (экран мог быть заблокирован
      // во время аудирования), смена шага догонится в tick()
      if (pauseIfAbandoned()) {
        render()
        return
      }
      if (hiddenAt && state.timer && state.timer.running) {
        const away = Date.now() - hiddenAt
        if (away > 60000) toast(`В фоне прошло ${L.fmtHuman(away / 60000)} — время зачтено`, 'ok')
      }
      hiddenAt = null
      render()
    })
    setInterval(tick, 1000)
    render()
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
