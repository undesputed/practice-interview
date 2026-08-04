// Persisted UI language (en | ja). Static chrome uses t(); AI coaching follows
// the interview language stored on the session.
const KEY = 'molave-lang';
const listeners = new Set();

const STR = {
  // ── Shell / nav ────────────────────────────────────────────────────────────
  'nav.dashboard':        { en: 'Dashboard',           ja: 'ダッシュボード' },
  'nav.history':          { en: 'History',             ja: '履歴' },
  'nav.notes':            { en: 'Notebook',            ja: 'ノート' },
  'nav.progress':         { en: 'Progress',            ja: '進捗' },
  'nav.practice':         { en: 'Practice Interview',  ja: '模擬面接' },
  'nav.liveTools':        { en: 'Live tools',          ja: 'ライブツール' },
  'nav.facial':           { en: 'Facial Analysis',     ja: '表情分析' },
  'nav.audio':            { en: 'Audio Analysis',      ja: '音声分析' },
  'nav.quickdraw':        { en: 'Quick Draw',          ja: 'クイックドロー' },
  'theme.light':          { en: 'Light mode',          ja: 'ライトモード' },
  'theme.dark':           { en: 'Dark mode',           ja: 'ダークモード' },
  'lang.label':           { en: 'Language',            ja: '言語' },

  // ── Common ─────────────────────────────────────────────────────────────────
  'common.loading':       { en: 'Loading…',            ja: '読み込み中…' },
  'common.notFound':      { en: 'Not found',           ja: '見つかりません' },
  'common.noScreen':      { en: 'No screen for this route.', ja: 'このページはありません。' },
  'common.exportPdf':     { en: 'Export PDF',          ja: 'PDF出力' },
  'common.questions':     { en: 'questions',           ja: '問' },
  'common.backHistory':   { en: '← History',           ja: '← 履歴' },
  'common.sessionMissing':{ en: 'Session not found.',  ja: 'セッションが見つかりません。' },
  'common.loadFailed':    { en: 'Could not load this session.', ja: 'セッションを読み込めませんでした。' },

  // ── Dashboard ──────────────────────────────────────────────────────────────
  'dash.title':           { en: 'Dashboard',           ja: 'ダッシュボード' },
  'dash.new':             { en: '＋ New practice interview', ja: '＋ 新しい模擬面接' },
  'dash.empty':           { en: 'No interviews yet.',  ja: 'まだ面接がありません。' },
  'dash.emptyHint':       { en: 'Start your first one to see stats and history here.', ja: '最初の面接を始めると、ここに統計と履歴が表示されます。' },
  'dash.total':           { en: 'Total sessions',      ja: 'セッション数' },
  'dash.avgConf':         { en: 'Avg confidence',      ja: '平均自信度' },
  'dash.avgNerv':         { en: 'Avg nervousness',     ja: '平均緊張度' },
  'dash.recent':          { en: 'Recent sessions',     ja: '最近のセッション' },
  'dash.viewAll':         { en: 'View all →',          ja: 'すべて見る →' },
  'dash.confTrend':       { en: 'Confidence over time', ja: '自信度の推移' },
  'dash.loadFail':        { en: 'Could not load sessions.', ja: 'セッションを読み込めませんでした。' },

  // ── Report / results ───────────────────────────────────────────────────────
  'report.execTitle':     { en: 'At a glance',         ja: 'ひと目でわかる結果' },
  'report.execSub':       { en: 'Score · headline · what to fix next', ja: 'スコア · 一言 · 次に直すこと' },
  'report.focus':         { en: 'Focus next',          ja: '次の改善ポイント' },
  'report.tryNext':       { en: 'Try this next',       ja: '次にやること' },
  'report.detailTitle':   { en: 'Full feedback',       ja: '詳細フィードバック' },
  'report.band.ready':    { en: 'Interview ready',     ja: '面接準備OK' },
  'report.band.almost':   { en: 'Almost there',        ja: 'もう少し' },
  'report.band.needs_work':{ en: 'Needs more practice', ja: '要練習' },
  'report.voice':         { en: 'Voice & delivery',    ja: '声・話し方' },
  'report.presence':      { en: 'On-camera presence',  ja: 'カメラ映り' },
  'report.content':       { en: 'Answer quality',      ja: '回答の質' },
  'report.didWell':       { en: 'What you did well',   ja: 'よかった点' },
  'report.workOn':        { en: 'What to work on',     ja: '改善ポイント' },
  'report.nextAction':    { en: 'Try this next:',      ja: '次にやること：' },
  'report.disclaimer':    { en: 'This is practice feedback to help you improve — not a hiring decision.', ja: 'これは練習用のフィードバックです。採用判断ではありません。' },
  'report.attention':     { en: 'Attention',           ja: '集中力' },
  'report.attentionHint': { en: 'Were you focused?',   ja: '集中できていましたか？' },
  'report.confidence':    { en: 'Confidence',          ja: '自信' },
  'report.confidenceHint':{ en: 'Did you project assurance?', ja: '落ち着いて見えましたか？' },
  'report.composure':     { en: 'Composure',           ja: '冷静さ' },
  'report.composureHint': { en: 'Did you stay steady?', ja: '安定していましたか？' },
  'report.calm':          { en: 'Calm',                ja: 'リラックス' },
  'report.calmHint':      { en: 'How relaxed were you?', ja: 'どれくらいリラックスしていましたか？' },
  'report.engagement':    { en: 'Engagement',          ja: 'エンゲージメント' },
  'report.engageSub':     { en: 'How present and active you were during the session', ja: 'セッション中の積極さと存在感' },
  'report.engage.high':   { en: 'Highly engaged',      ja: 'とても積極的' },
  'report.engage.mid':    { en: 'Moderately engaged',  ja: 'まずまず積極的' },
  'report.engage.low':    { en: 'Low engagement',      ja: '積極性が低い' },
  'report.eyeContact':    { en: 'eye contact with camera', ja: 'カメラへの視線' },
  'report.spokePct':      { en: 'of session you spoke', ja: '発話した割合' },
  'report.avgRespond':    { en: 'avg time to respond', ja: '平均応答時間' },
  'report.faceVisible':   { en: 'face visible in frame', ja: '顔が映っていた割合' },
  'report.howCame':       { en: 'How you came across', ja: '相手からどう見えたか' },
  'report.howCameSub':    { en: 'A plain-English summary of your on-camera presence.', ja: 'カメラ映りのわかりやすいまとめ。' },
  'report.scoreHow':      { en: 'How your score is calculated', ja: 'スコアの計算方法' },
  'report.perQ':          { en: 'Question by question', ja: '質問ごと' },
  'report.perQSub':       { en: 'A snapshot of how you performed on each question.', ja: '各質問での様子のスナップショット。' },
  'report.qCol':          { en: 'Question',            ja: '質問' },
  'report.eyeCol':        { en: 'Eye contact',         ja: '視線' },
  'report.compCol':       { en: 'Composure',           ja: '冷静さ' },
  'report.respCol':       { en: 'Response time',       ja: '応答時間' },
  'report.voiceTitle':    { en: 'Voice & delivery',    ja: '声・話し方' },
  'report.voiceSub':      { en: 'Based on your recorded audio — how fast you spoke, filler words, silences, and vocal variety.', ja: '録音音声から：話す速さ、フィラー、沈黙、声の抑揚。' },
  'report.emoTitle':      { en: 'Emotional tone',      ja: '感情トーン' },
  'report.emoSub':        { en: 'Approximate mix from facial muscle movement (MediaPipe). Bars are average intensity across the session — not a clinical reading.', ja: '表情筋の動きからのおおよその割合（MediaPipe）。バーはセッション全体の平均強度です。診断ではありません。' },
  'report.facsTitle':     { en: 'Facial signals',      ja: '表情シグナル' },
  'report.facsSub':       { en: 'Which facial muscles were active and how strongly — gives a rough picture of what your face was expressing.', ja: 'どの表情筋がどれくらい動いたか — 顔の印象の目安。' },
  'report.composureTrend':{ en: 'Composure across questions', ja: '質問ごとの冷静さ' },
  'report.composureTrendSub':{ en: 'How calm and steady you looked as each question progressed.', ja: '各質問でどれくらい落ち着いて見えたか。' },
  'report.good':          { en: 'Good', ja: '良い' },
  'report.ok':            { en: 'OK',   ja: '普通' },
  'report.low':           { en: 'Low',  ja: '低い' },

  'report.engage.highText': { en: 'You showed strong signs of active participation — solid eye contact, speaking a healthy amount, and staying alert.', ja: '積極的に参加していました。視線・発話・集中がしっかりしています。' },
  'report.engage.midText':  { en: 'Your engagement was decent. A bit more eye contact or speaking more actively could make you feel even more present.', ja: 'まずまずです。視線や発話をもう少し増やすと、より存在感が出ます。' },
  'report.engage.lowText':  { en: 'Engagement seemed low during this session. Try to keep your eyes toward the camera and respond more actively to each question.', ja: '積極性が低めです。カメラを見て、質問にもっと積極的に答えましょう。' },

  'report.impr.eye':     { en: 'Eye contact', ja: '視線' },
  'report.impr.body':    { en: 'Body language & posture', ja: 'ボディランゲージ・姿勢' },
  'report.impr.face':    { en: 'Facial expression', ja: '表情' },
  'report.impr.emo':     { en: 'Emotional tone', ja: '感情トーン' },
  'report.impr.eyeHigh': { en: 'Strong — you kept your eyes toward the camera {pct}% of the time. This reads as confident and engaged.', ja: '良い — カメラへの視線が {pct}%。自信と集中が伝わります。' },
  'report.impr.eyeMid':  { en: 'Decent at {pct}%. Try to look at your camera lens more directly — it signals confidence.', ja: 'まずまず（{pct}%）。レンズを直接見ると、より自信が伝わります。' },
  'report.impr.eyeLow':  { en: 'Low at {pct}%. Practice looking at the camera rather than the screen to appear more engaged.', ja: '低め（{pct}%）。画面ではなくカメラを見る練習を。' },
  'report.impr.eyeNone': { en: 'No eye-contact data captured for this session.', ja: 'このセッションでは視線データがありません。' },
  'report.impr.bodyHigh':{ en: 'Calm and controlled — your posture and head stayed mostly still, which projects confidence.', ja: '落ち着いて安定。姿勢と頭の動きが少なく、自信が伝わります。' },
  'report.impr.bodyMid': { en: 'Mostly steady. Some movement was detected — try to relax and avoid fidgeting.', ja: 'おおむね安定。少し動きがありました — リラックスして余計な動きを抑えましょう。' },
  'report.impr.bodyLow': { en: 'Some restlessness was picked up. Try sitting upright, keeping your hands still, and breathing slowly.', ja: '落ち着きのなさが検出されました。背筋を伸ばし、手を静かにして、ゆっくり呼吸を。' },
  'report.impr.bodyNone':{ en: 'Posture data not available.', ja: '姿勢データがありません。' },
  'report.impr.upright': { en: 'Sat upright {pct}% of the time', ja: '上体がまっすぐだった時間 {pct}%' },
  'report.impr.smileHigh':{ en: 'Warm and expressive — you smiled {pct}% of the session, which makes you seem friendly and enthusiastic.', ja: '明るく表情豊か — 笑顔が {pct}%。親しみやすさが伝わります。' },
  'report.impr.smileMid': { en: 'Mostly neutral ({pct}% smiling). A little more natural smiling — especially when listening — would help you seem more approachable.', ja: 'ほぼ無表情（笑顔 {pct}%）。聞くときの自然な笑顔があると近づきやすくなります。' },
  'report.impr.smileLow': { en: 'Very little smiling detected ({pct}%). Occasional smiling makes a big difference in how likeable you come across.', ja: '笑顔がほとんどありません（{pct}%）。たまに笑うだけで印象が大きく変わります。' },
  'report.impr.smileNone':{ en: 'Smile data not available.', ja: '笑顔データがありません。' },
  'report.impr.emoHas':  { en: 'Your face mostly expressed {dom}{compound}. This is an approximate reading based on facial muscle movement.', ja: '表情は主に「{dom}」{compound}。表情筋からのおおよその推定です。' },
  'report.impr.emoCompound': { en: ' — overall you came across as {c}', ja: ' — 全体として「{c}」に見えます' },
  'report.impr.emoNone': { en: 'Emotional tone data not available for this session.', ja: '感情トーンのデータがありません。' },

  'report.voice.na':       { en: 'Voice analysis was not available for this session.', ja: 'このセッションでは音声分析がありません。' },
  'report.voice.speed':    { en: 'Speaking speed', ja: '話す速さ' },
  'report.voice.fillers':  { en: 'Filler words (um, uh, like…)', ja: 'フィラー（えっと、あの…）' },
  'report.voice.pauses':   { en: 'Long silences (over 2 sec)', ja: '長い沈黙（2秒超）' },
  'report.voice.variety':  { en: 'Vocal variety', ja: '声の抑揚' },
  'report.voice.slow':     { en: 'a bit slow — try speaking more naturally', ja: 'やや遅い — もう少し自然な速さで' },
  'report.voice.fast':     { en: 'a bit fast — try slowing down slightly', ja: 'やや速い — 少しゆっくりと' },
  'report.voice.paceOk':   { en: 'good pace', ja: '良いペース' },
  'report.voice.fillOk':   { en: 'excellent', ja: 'とても良い' },
  'report.voice.fillMid':  { en: 'decent', ja: 'まずまず' },
  'report.voice.fillBad':  { en: 'try to reduce these', ja: '減らしましょう' },
  'report.voice.pauseNone':{ en: 'none — great!', ja: 'なし — 良い！' },
  'report.voice.pauseOk':  { en: 'fine', ja: '問題なし' },
  'report.voice.pauseBad': { en: 'aim for 2 or fewer', ja: '2回以下を目指して' },
  'report.voice.pitchOk':  { en: 'expressive', ja: '抑揚あり' },
  'report.voice.pitchFlat':{ en: 'a bit flat — try varying your tone more', ja: 'やや平坦 — 抑揚をつけて' },
  'report.voice.privacy':  { en: 'Your audio was analyzed and then deleted — it is never stored.', ja: '音声は分析後に削除されます。保存されません。' },
  'report.voice.per100':   { en: '{n} per 100 words', ja: '100語あたり {n}' },
  'report.voice.hzVar':    { en: '{n} Hz variation', ja: '変動 {n} Hz' },

  'report.facs.na':   { en: 'No facial-signal data for this session.', ja: '表情シグナルのデータがありません。' },
  'report.facs.A':    { en: 'barely noticeable', ja: 'ほとんど見えない' },
  'report.facs.B':    { en: 'slight', ja: 'わずか' },
  'report.facs.C':    { en: 'noticeable', ja: 'はっきり' },
  'report.facs.D':    { en: 'strong', ja: '強い' },
  'report.facs.E':    { en: 'very strong', ja: '非常に強い' },
  'report.emo.na':    { en: 'Emotional tone data not available.', ja: '感情トーンのデータがありません。' },
  'report.emo.overall':{ en: 'Overall tone:', ja: '全体のトーン：' },
  'report.coach.na':  { en: 'AI coaching was not generated for this session.', ja: 'このセッションではAIコーチングが生成されていません。' },
  'report.translating':{ en: 'Translating feedback to Japanese…', ja: 'フィードバックを日本語に翻訳中…' },
  'report.translateFail':{ en: 'Could not translate AI feedback (server missing API key or translation failed). Showing English.', ja: 'AIフィードバックを翻訳できませんでした（APIキー未設定または翻訳失敗）。英語のまま表示します。' },
  'report.scoreHowBody': {
    en: 'Your readiness score combines three things: how you sounded ({d}), how you looked on camera ({p}), and what you actually said ({c}). If one signal wasn\'t captured, the others carry more weight. Scores: 70+ = interview ready · 50–69 = almost there · under 50 = needs more practice.',
    ja: '準備度スコアは次の3つを組み合わせます：話し方（{d}）、カメラ映り（{p}）、回答内容（{c}）。欠けた項目は他が補います。70以上＝準備OK · 50–69＝もう少し · 50未満＝要練習。',
  },
  'report.pillar.delivery': { en: 'How you sounded — voice & delivery', ja: '話し方 — 声・デリバリー' },
  'report.pillar.presence': { en: 'How you looked — on-camera presence', ja: '見え方 — カメラ映り' },
  'report.pillar.content':  { en: 'What you said — answer quality', ja: '内容 — 回答の質' },
  'report.ofScore':         { en: 'of score', ja: 'の割合' },
  'report.notCaptured':     { en: 'not captured', ja: '未計測' },

  // ── Other screens (titles / chrome) ────────────────────────────────────────
  'history.title':        { en: 'History',             ja: '履歴' },
  'progress.title':       { en: 'Progress',            ja: '進捗' },
  'notes.title':          { en: 'Notebook',            ja: 'ノート' },
  'facial.title':         { en: 'Facial Analysis',     ja: '表情分析' },
  'audio.title':          { en: 'Audio Analysis',      ja: '音声分析' },
  'quickdraw.title':      { en: 'Quick Draw',          ja: 'クイックドロー' },
  'practice.title':       { en: 'Practice Interview',  ja: '模擬面接' },

  // ── History table chrome ───────────────────────────────────────────────────
  'history.search':       { en: 'Search by role or label…', ja: '職種・ラベルで検索…' },
  'history.newest':       { en: 'Newest first',        ja: '新しい順' },
  'history.oldest':       { en: 'Oldest first',        ja: '古い順' },
  'history.date':         { en: 'Date',                ja: '日付' },
  'history.role':         { en: 'Role',                ja: '職種' },
  'history.attention':    { en: 'Attention',           ja: '集中力' },
  'history.confidence':   { en: 'Confidence',          ja: '自信' },
  'history.nerves':       { en: 'Nerves',              ja: '緊張' },
  'history.composure':    { en: 'Composure',           ja: '冷静さ' },
  'history.view':         { en: 'View',                ja: '見る' },
  'history.rename':       { en: 'Rename',              ja: '名前変更' },
  'history.delete':       { en: 'Delete',              ja: '削除' },
  'history.deleteConfirm':{ en: 'Delete this session permanently?', ja: 'このセッションを完全に削除しますか？' },
  'history.renamePrompt': { en: 'Label for this session:', ja: 'このセッションのラベル：' },
  'history.empty':        { en: 'No matching sessions.', ja: '該当するセッションがありません。' },
  'history.loadFail':     { en: 'Could not load sessions.', ja: 'セッションを読み込めませんでした。' },
  'history.interview':    { en: 'Interview',           ja: '面接' },
};

// Known role / scenario phrases stored on sessions (English) → Japanese display.
// Longer phrases first so partial replaces don't leave English remnants.
const ROLE_PHRASES = [
  ['Software engineer System design + coding talk-through', 'ソフトウェアエンジニア（システム設計・コーディング）'],
  ['Product manager Behavioral + product sense', 'プロダクトマネージャー（行動面接・プロダクトセンス）'],
  ['Designer Portfolio + critique', 'デザイナー（ポートフォリオ・講評）'],
  ['Data analyst Metrics + case study', 'データアナリスト（指標・ケーススタディ）'],
  ['Other General interview practice', 'その他（一般的な面接練習）'],
  ['System design + coding talk-through', 'システム設計・コーディング'],
  ['Behavioral + product sense', '行動面接・プロダクトセンス'],
  ['Portfolio + critique', 'ポートフォリオ・講評'],
  ['Metrics + case study', '指標・ケーススタディ'],
  ['General interview practice', '一般的な面接練習'],
  ['Nail a job interview', '就職面接を攻略'],
  ['Deliver a presentation', 'プレゼンを行う'],
  ['Handle a tough talk', '難しい会話に対応'],
  ['Pitch and persuade', 'ピッチと説得'],
  ['Negotiate a deal', '交渉する'],
  ['Crack a case interview', 'ケース面接を解く'],
  ['Software Engineer', 'ソフトウェアエンジニア'],
  ['Software engineer', 'ソフトウェアエンジニア'],
  ['Product Manager', 'プロダクトマネージャー'],
  ['Product manager', 'プロダクトマネージャー'],
  ['Data Analyst', 'データアナリスト'],
  ['Data analyst', 'データアナリスト'],
  ['Customer Support', 'カスタマーサポート'],
  ['Designer', 'デザイナー'],
  ['Other', 'その他'],
  ['Interview', '面接'],
  ['Session', 'セッション'],
];

/** Display a saved session role/label in the current UI language. */
export function localizeRole(text){
  const raw = (text == null || text === '') ? null : String(text);
  if (currentLang() !== 'ja') return raw || 'Interview';
  if (!raw) return STR['history.interview'].ja;
  let out = raw;
  for (const [en, ja] of ROLE_PHRASES){
    if (out.indexOf(en) >= 0) out = out.split(en).join(ja);
  }
  return out;
}

export function initLang(){
  const saved = localStorage.getItem(KEY);
  const lang = saved === 'ja' ? 'ja' : 'en';
  document.documentElement.setAttribute('lang', lang);
  document.documentElement.setAttribute('data-lang', lang);
  return lang;
}

export function currentLang(){
  return document.documentElement.getAttribute('data-lang') === 'ja' ? 'ja' : 'en';
}

export function setLang(lang){
  const next = lang === 'ja' ? 'ja' : 'en';
  document.documentElement.setAttribute('lang', next);
  document.documentElement.setAttribute('data-lang', next);
  localStorage.setItem(KEY, next);
  listeners.forEach((fn) => { try { fn(next); } catch (_){} });
  return next;
}

export function toggleLang(){
  return setLang(currentLang() === 'ja' ? 'en' : 'ja');
}

export function onLangChange(fn){
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Translate a key. Optional vars: t('x', { n: 3 }) replaces {n} in the string. */
export function t(key, vars){
  const entry = STR[key];
  let s = entry ? (entry[currentLang()] || entry.en || key) : key;
  if (vars){
    for (const [k, v] of Object.entries(vars)){
      s = s.replace(new RegExp('\\{' + k + '\\}', 'g'), String(v));
    }
  }
  return s;
}

export function bandLabel(band){
  return t('report.band.' + (band || 'needs_work'));
}
