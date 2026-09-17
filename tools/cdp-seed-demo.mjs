const CDP = 'http://127.0.0.1:9333';
const list = await (await fetch(`${CDP}/json/list`)).json();
const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (m, p = {}) =>
  new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method: m, params: p }));
  });
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  }
});
await new Promise(r => ws.addEventListener('open', r));
await send('Runtime.enable');

const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r.exceptionDetails ? 'EXC: ' + JSON.stringify(r.exceptionDetails).slice(0, 300) : r.result.value;
};

// 清掉之前注入的脏数据
console.log(
  await ev(`(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('wordrealm'); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); });
  await new Promise((res, rej) => {
    const t = db.transaction(['mistakes','questions'], 'readwrite');
    t.objectStore('mistakes').clear();
    t.objectStore('questions').clear();
    t.oncomplete = res; t.onerror = () => rej(t.error);
  });
  return '已清空 mistakes + questions';
})()`),
);

// 重新注入，这次直接内联完整对象（不复用函数，排除注入脚本自身的问题）
console.log(
  await ev(`(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('wordrealm'); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); });

  const STEMS = [
    ['The report ___ by the committee was rejected.', ['writing','written','to write','writes'], 1],
    ['She has lived here ___ 2015.', ['since','for','from','during'], 0],
    ['The evidence ___ by the reporters was used in court.', ['collecting','collected','to collect','collects'], 1],
    ['This is the village ___ the law was introduced.', ['which','where','who','whose'], 1],
    ['If I ___ you, I would accept the offer.', ['am','was','were','be'], 2],
    ['Not only ___ he sing well, but he also dances.', ['did','does','has','had'], 0],
  ];
  const POINTS = ['T5','T1','T5','T6','T9','T10'];

  const questions = [];
  for (let i = 0; i < 8; i++) {
    const s = STEMS[i % STEMS.length];
    questions.push({
      id: 'demo-q-' + i,
      point: POINTS[i % POINTS.length],
      difficulty: (i % 3) + 1,
      stem: s[0],
      options: s[1],
      answer: s[2],
      why: '此处需要过去分词作后置定语，与逻辑主语之间是被动关系。',
      trap: '容易误选主动形式，因为看到 by 就以为要用主动语态，忽略了主语的被动关系。',
      zh: '委员会写的那份报告被否决了。',
      createdAt: Date.now() + i,
      sourceWords: ['report','committee'],
      seen: 0, correct: 0, unused: 1, origin: 'ai',
    });
  }

  const mistakes = [];
  for (let i = 0; i < 5; i++) {
    const q = questions[i];
    mistakes.push({
      questionId: q.id + '-m',
      point: q.point,
      difficulty: q.difficulty,
      stem: q.stem,                 // 必须带上
      options: q.options,           // 必须带上
      answer: q.answer,
      chosen: (q.answer + 1) % 4,
      why: q.why,
      trap: q.trap,
      zh: q.zh,
      sourceWords: q.sourceWords,
      createdAt: Date.now() - i * 86400000,
      retries: i > 2 ? 1 : 0,
      resolvedCorrect: i > 2,
    });
  }

  await new Promise((res, rej) => {
    const t = db.transaction(['questions','mistakes'], 'readwrite');
    const qs = t.objectStore('questions');
    const ms = t.objectStore('mistakes');
    questions.forEach(q => qs.put(q));
    mistakes.forEach(m => ms.put(m));
    t.oncomplete = res; t.onerror = () => rej(t.error);
  });

  // 回读校验：确认 stem/options 真的写进去了
  const check = await new Promise((res, rej) => {
    const t = db.transaction(['mistakes'], 'readonly');
    const g = t.objectStore('mistakes').getAll();
    g.onsuccess = () => res(g.result); g.onerror = () => rej(g.error);
  });
  const bad = check.filter(m => typeof m.stem !== 'string' || !Array.isArray(m.options));
  return 'questions=8 mistakes=' + check.length + '  字段不合格=' + bad.length +
    (bad.length ? '  样例=' + JSON.stringify(bad[0]).slice(0,200) : '  ✅ 全部完整');
})()`),
);

ws.close();
