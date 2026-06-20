const { useState, useEffect, useMemo, useCallback } = React;

/* ---- Storage shim: real browsers don't have window.storage (that's a
   Claude-artifact-only API), so this build uses localStorage instead,
   wrapped to match the same async get/set/throw-if-missing shape. ---- */
const storage = {
  async get(key) {
    const raw = window.localStorage.getItem(key);
    if (raw === null) throw new Error('not found');
    return { key, value: raw };
  },
  async set(key, value) {
    window.localStorage.setItem(key, value);
    return { key, value };
  },
};

/* =========================================================================
   DATA SCHEMA
   Node = a learning concept (usually one word), the "hub" object.
   Card = one reviewable unit; references a node (optional) + a type.
   Tag  = many-to-many label on cards/nodes, grouped by category.
   Progress = persisted learner state: per-card SRS, per-tag scores,
              per-dimension scores, totals, streak.
========================================================================= */

const TAG_META = [
  { name: 'A1', category: 'level' }, { name: 'A2', category: 'level' },
  { name: 'Familie', category: 'topic' }, { name: 'Arbeit', category: 'topic' },
  { name: 'Reisen', category: 'topic' }, { name: 'Tagesablauf', category: 'topic' },
  { name: 'Nominativ', category: 'grammar' }, { name: 'Akkusativ', category: 'grammar' },
  { name: 'Dativ', category: 'grammar' }, { name: 'Modalverben', category: 'grammar' },
  { name: 'Perfekt', category: 'grammar' },
  { name: 'Vocabulary', category: 'skill' }, { name: 'Sentence', category: 'skill' },
  { name: 'Grammar', category: 'skill' }, { name: 'Speaking', category: 'skill' },
  { name: 'Writing', category: 'skill' }, { name: 'Listening', category: 'skill' },
];
const tagCategory = (name) => TAG_META.find(t => t.name === name)?.category || 'topic';

/* ---- NODES ------------------------------------------------------------ */
const NODES = [
  { id: 'n_eltern', lemma: 'die Eltern', pos: 'Nomen (nur Plural)', article: 'die',
    plural: 'die Eltern (kein Singular)', translation: 'parents',
    example_de: 'Meine Eltern kommen am Wochenende zu Besuch.',
    example_en: 'My parents are visiting this weekend.',
    tags: ['Familie', 'A2', 'Vocabulary'], relatedNodeIds: ['n_vater', 'n_mutter'],
    grammarNotes: '"Eltern" only exists in the plural \u2014 there is no everyday singular form. It always takes plural verb endings and the article "die".',
    collocations: ['die Eltern besuchen', 'bei den Eltern wohnen', 'die Erlaubnis der Eltern'] },
  { id: 'n_vater', lemma: 'der Vater', pos: 'Nomen', article: 'der', plural: 'die V\u00e4ter',
    translation: 'father', example_de: 'Mein Vater arbeitet als Lehrer.', example_en: 'My father works as a teacher.',
    tags: ['Familie', 'A2', 'Vocabulary'], relatedNodeIds: ['n_eltern', 'n_mutter'],
    grammarNotes: 'Masculine noun \u2014 "der" in Nominativ becomes "den" in Akkusativ: "Ich sehe den Vater."',
    collocations: ['Vater werden', 'Vater und Sohn', 'der leibliche Vater'] },
  { id: 'n_mutter', lemma: 'die Mutter', pos: 'Nomen', article: 'die', plural: 'die M\u00fctter',
    translation: 'mother', example_de: 'Die Mutter kocht das Abendessen.', example_en: 'The mother cooks dinner.',
    tags: ['Familie', 'A2', 'Vocabulary'], relatedNodeIds: ['n_vater', 'n_eltern'] },
  { id: 'n_bruder', lemma: 'der Bruder', pos: 'Nomen', article: 'der', plural: 'die Br\u00fcder',
    translation: 'brother', example_de: 'Ich habe einen \u00e4lteren Bruder.', example_en: 'I have an older brother.',
    tags: ['Familie', 'A2', 'Vocabulary'], relatedNodeIds: ['n_schwester'] },
  { id: 'n_schwester', lemma: 'die Schwester', pos: 'Nomen', article: 'die', plural: 'die Schwestern',
    translation: 'sister', example_de: 'Meine Schwester wohnt in Berlin.', example_en: 'My sister lives in Berlin.',
    tags: ['Familie', 'A2', 'Vocabulary'], relatedNodeIds: ['n_bruder'] },
  { id: 'n_kind', lemma: 'das Kind', pos: 'Nomen', article: 'das', plural: 'die Kinder',
    translation: 'child', example_de: 'Das Kind spielt im Garten.', example_en: 'The child plays in the garden.',
    tags: ['Familie', 'A2', 'Vocabulary'] },
  { id: 'n_aufstehen', lemma: 'aufstehen', pos: 'Verb (trennbar)', article: null, plural: null,
    translation: 'to get up', example_de: 'Ich stehe um sieben Uhr auf.', example_en: 'I get up at seven o\u2019clock.',
    tags: ['Tagesablauf', 'A2', 'Vocabulary', 'Perfekt'], relatedNodeIds: ['n_einkaufen'],
    grammarNotes: 'Separable verb: the prefix "auf-" splits off in main clauses ("Ich stehe ... auf"), but the Perfekt uses "sein" (change of state): "Ich bin aufgestanden."',
    collocations: ['fr\u00fch aufstehen', 'sp\u00e4t aufstehen', 'rechtzeitig aufstehen'] },
  { id: 'n_einkaufen', lemma: 'einkaufen', pos: 'Verb (trennbar)', translation: 'to go shopping',
    example_de: 'Am Samstag kaufe ich Lebensmittel ein.', example_en: 'On Saturday I buy groceries.',
    tags: ['Tagesablauf', 'A2', 'Vocabulary', 'Akkusativ'], relatedNodeIds: ['n_aufstehen'],
    grammarNotes: 'Separable verb; its direct object ("Lebensmittel") is Akkusativ.',
    collocations: ['im Supermarkt einkaufen', 'online einkaufen', 'einkaufen gehen'] },
  { id: 'n_arbeiten', lemma: 'arbeiten', pos: 'Verb', translation: 'to work',
    example_de: 'Ich arbeite von neun bis f\u00fcnf.', example_en: 'I work from nine to five.',
    tags: ['Arbeit', 'A2', 'Vocabulary'] },
  { id: 'n_kochen', lemma: 'kochen', pos: 'Verb', translation: 'to cook',
    example_de: 'Meine Mutter kocht gern italienisch.', example_en: 'My mother likes to cook Italian.',
    tags: ['Tagesablauf', 'A2', 'Vocabulary'] },
  { id: 'n_schlafen', lemma: 'schlafen', pos: 'Verb', translation: 'to sleep',
    example_de: 'Das Baby schl\u00e4ft acht Stunden.', example_en: 'The baby sleeps eight hours.',
    tags: ['Tagesablauf', 'A2', 'Vocabulary'] },
];
const nodeById = (id) => NODES.find(n => n.id === id);

/* ---- CARDS -------------------------------------------------------------
   Discriminated union by `type`. Common fields: id, type, nodeId, tags[], dimension.
-------------------------------------------------------------------------- */
const vocabCards = NODES.map(n => ({ id: `v_${n.id}`, type: 'vocab', nodeId: n.id, tags: n.tags, dimension: 'recognition' }));

const sentenceCards = [
  { id: 's1', type: 'sentence', nodeId: null, tags: ['Familie', 'Sentence', 'A2'], dimension: 'production',
    direction: 'en-de', prompt: 'My parents live in Hamburg.', answer: 'Meine Eltern wohnen in Hamburg.' },
  { id: 's2', type: 'sentence', nodeId: 'n_aufstehen', tags: ['Tagesablauf', 'Sentence', 'A2'], dimension: 'recognition',
    direction: 'de-en', prompt: 'Ich stehe jeden Tag fr\u00fch auf.', answer: 'I get up early every day.' },
  { id: 's3', type: 'sentence', nodeId: 'n_einkaufen', tags: ['Tagesablauf', 'Sentence', 'Akkusativ'], dimension: 'production',
    direction: 'en-de', prompt: 'On Saturday we go shopping together.', answer: 'Am Samstag kaufen wir zusammen ein.' },
  { id: 's4', type: 'sentence', nodeId: null, tags: ['Familie', 'Sentence', 'Dativ'], dimension: 'recognition',
    direction: 'de-en', prompt: 'Mein Vater hilft meiner Mutter in der K\u00fcche.', answer: 'My father helps my mother in the kitchen.' },
  { id: 's5', type: 'sentence', nodeId: null, tags: ['Familie', 'Sentence', 'A2'], dimension: 'production',
    direction: 'en-de', prompt: 'I have an older brother and a younger sister.', answer: 'Ich habe einen \u00e4lteren Bruder und eine j\u00fcngere Schwester.' },
];

const grammarCards = [
  { id: 'g1', type: 'grammar', nodeId: 'n_vater', tags: ['Nominativ', 'Grammar', 'Familie'], dimension: 'grammar',
    mode: 'choose-article', prompt: '___ Vater arbeitet in Berlin.', options: ['der', 'die', 'das'],
    answer: 'der', explanation: '"Vater" is masculine, so it takes "der" in the Nominativ.' },
  { id: 'g2', type: 'grammar', nodeId: 'n_vater', tags: ['Akkusativ', 'Grammar'], dimension: 'grammar',
    mode: 'identify-case', prompt: 'Ich sehe den Vater.', question: 'Welcher Fall ist "den Vater"?',
    options: ['Nominativ', 'Akkusativ', 'Dativ'], answer: 'Akkusativ',
    explanation: '"sehen" takes a direct object \u2192 Akkusativ. Masculine "der" becomes "den".' },
  { id: 'g3', type: 'grammar', nodeId: 'n_aufstehen', tags: ['Tagesablauf', 'Grammar'], dimension: 'grammar',
    mode: 'fill-blank', prompt: 'Ich ___ um sieben Uhr ___. (aufstehen)', answer: 'stehe ... auf',
    explanation: 'Separable verb: the prefix "auf" moves to the end of the main clause.' },
  { id: 'g4', type: 'grammar', nodeId: null, tags: ['Modalverben', 'Grammar'], dimension: 'grammar',
    mode: 'conjugate', prompt: 'Wir ___ heute arbeiten. (m\u00fcssen)', answer: 'm\u00fcssen',
    explanation: 'Modal verb "m\u00fcssen", 1st person plural \u2014 identical to the infinitive for "wir".' },
  { id: 'g5', type: 'grammar', nodeId: 'n_aufstehen', tags: ['Perfekt', 'Grammar', 'Tagesablauf'], dimension: 'grammar',
    mode: 'fill-blank', prompt: 'Gestern ___ ich um acht Uhr ___. (aufstehen, Perfekt)', answer: 'bin ... aufgestanden',
    explanation: 'Verbs of motion or change of state take "sein" in the Perfekt: "bin aufgestanden".' },
];

const speakingCards = [
  { id: 'sp1', type: 'speaking', nodeId: 'n_eltern', tags: ['Familie', 'Speaking', 'A2'], dimension: 'production',
    seconds: 30, prompt: 'Stell deine Familie vor.',
    modelAnswer: 'Meine Familie ist nicht sehr gro\u00df. Ich habe einen Bruder und eine Schwester. Mein Vater arbeitet als Lehrer und meine Mutter arbeitet im Krankenhaus. Wir wohnen zusammen in Hamburg.' },
  { id: 'sp2', type: 'speaking', nodeId: 'n_aufstehen', tags: ['Tagesablauf', 'Speaking', 'A2'], dimension: 'production',
    seconds: 25, prompt: 'Beschreibe deinen typischen Tagesablauf.',
    modelAnswer: 'Ich stehe um sieben Uhr auf und dusche mich. Danach fr\u00fchst\u00fccke ich und gehe zur Arbeit. Mittags esse ich mit Kollegen. Abends koche ich und sehe fern, bevor ich ins Bett gehe.' },
  { id: 'sp3', type: 'speaking', nodeId: null, tags: ['Familie', 'Tagesablauf', 'Speaking', 'Perfekt'], dimension: 'production',
    seconds: 25, prompt: 'Was hast du am Wochenende gemacht?',
    modelAnswer: 'Am Wochenende habe ich eingekauft und meine Eltern besucht. Wir haben zusammen gekocht und ferngesehen.' },
];

const writingCards = [
  { id: 'w1', type: 'writing', nodeId: null, tags: ['Writing', 'A2'], dimension: 'production',
    prompt: 'Schreib eine Nachricht an einen Freund: Du kannst nicht zur Party kommen. Sag warum und schlage einen neuen Termin vor. (ca. 30 W\u00f6rter)',
    modelAnswer: 'Hallo Tom, leider kann ich am Samstag nicht zu deiner Party kommen, weil ich arbeiten muss. K\u00f6nnen wir uns stattdessen am Sonntag treffen? Ich freue mich schon! Liebe Gr\u00fc\u00dfe, Anna' },
  { id: 'w2', type: 'writing', nodeId: 'n_eltern', tags: ['Familie', 'Writing', 'A2'], dimension: 'production',
    prompt: 'Stell deine Familie in einem kurzen Text vor (ca. 30 W\u00f6rter).',
    modelAnswer: 'Meine Familie besteht aus vier Personen: meinem Vater, meiner Mutter, meinem Bruder und mir. Meine Eltern wohnen in M\u00fcnchen. Wir treffen uns oft am Wochenende.' },
];

const listeningCards = [
  { id: 'l1', type: 'listening', nodeId: 'n_vater', tags: ['Familie', 'Listening', 'A2'], dimension: 'recognition',
    textToSpeak: 'Mein Vater arbeitet als Lehrer.', answer: 'Mein Vater arbeitet als Lehrer.', translation: 'My father works as a teacher.' },
  { id: 'l2', type: 'listening', nodeId: 'n_aufstehen', tags: ['Tagesablauf', 'Listening', 'A2'], dimension: 'recognition',
    textToSpeak: 'Ich stehe um sieben Uhr auf.', answer: 'Ich stehe um sieben Uhr auf.', translation: 'I get up at seven o\u2019clock.' },
  { id: 'l3', type: 'listening', nodeId: 'n_einkaufen', tags: ['Tagesablauf', 'Listening', 'Akkusativ'], dimension: 'recognition',
    textToSpeak: 'Am Samstag kaufe ich Lebensmittel ein.', answer: 'Am Samstag kaufe ich Lebensmittel ein.', translation: 'On Saturday I buy groceries.' },
];

const CARDS = [...vocabCards, ...sentenceCards, ...grammarCards, ...speakingCards, ...writingCards, ...listeningCards];

/* =========================================================================
   SRS ENGINE — simplified SM-2 (unchanged core logic from v1)
========================================================================= */
const STORAGE_KEY = 'german_a2_learning_system_v1';
const NEW_CARD_LIMIT = 14;

function todayStr() { return new Date().toISOString().slice(0, 10); }
function addDays(dateStr, days) { const d = new Date(dateStr + 'T00:00:00'); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); }
function daysBetween(a, b) { return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000); }

function nextSrsState(old, grade) {
  const reps = old?.reps ?? 0, interval = old?.interval ?? 0, ease = old?.ease ?? 2.5, today = todayStr();
  if (grade === 'again') return { reps: 0, interval: 0, ease: Math.max(1.3, ease - 0.2), due: today };
  if (grade === 'hard') { const ni = Math.max(1, Math.round((interval || 1) * 1.2)); return { reps, interval: ni, ease: Math.max(1.3, ease - 0.15), due: addDays(today, ni) }; }
  if (grade === 'good') { let ni; if (reps === 0) ni = 1; else if (reps === 1) ni = 6; else ni = Math.round(interval * ease); return { reps: reps + 1, interval: ni, ease, due: addDays(today, ni) }; }
  let ni; if (reps === 0) ni = 2; else if (reps === 1) ni = 8; else ni = Math.round(interval * ease * 1.3);
  return { reps: reps + 1, interval: ni, ease: ease + 0.15, due: addDays(today, ni) };
}
function previewLabel(old, grade) {
  if (grade === 'again') return 'heute';
  const d = nextSrsState(old, grade).interval;
  return d <= 0 ? 'heute' : d === 1 ? '1 Tag' : `${d} Tage`;
}
const gradeValue = (g) => ({ again: 0, hard: 0.45, good: 0.8, easy: 1 }[g]);
function emaUpdate(prev, value, alpha = 0.25) { if (!prev) return { score: value, count: 1 }; return { score: prev.score * (1 - alpha) + value * alpha, count: prev.count + 1 }; }

/* =========================================================================
   SMALL UI PRIMITIVES
========================================================================= */
function GenderBadge({ gender }) {
  if (!gender) return <div className="ln-badge ln-badge-verb"><span>VERB</span></div>;
  const shape = gender === 'der' ? 'square' : gender === 'die' ? 'circle' : 'triangle';
  return <div className={`ln-badge ln-badge-${gender}`}><span className={`ln-shape ln-shape-${shape}`} />{gender}</div>;
}
function TagChip({ tag, active, onClick }) {
  return <button className={`ln-chip ln-chip-${tagCategory(tag)} ${active ? 'ln-chip-active' : ''}`} onClick={onClick}>{tag}</button>;
}
function MasteryDots({ reps }) {
  const r = Math.min(reps ?? 0, 5);
  return <div className="ln-mastery">{[0,1,2,3,4].map(i => <span key={i} className={`ln-dot ${i < r ? 'ln-dot-filled' : ''}`} />)}<span className="ln-mastery-label">{r === 0 ? 'Neu' : r < 3 ? 'Lernend' : 'Gefestigt'}</span></div>;
}
function GradeButtons({ cardId, oldSrs, onGrade }) {
  return (
    <div className="ln-grades">
      <button className="ln-btn ln-btn-again" onClick={() => onGrade(cardId, 'again')}>Nochmal<span className="ln-btn-preview">{previewLabel(oldSrs, 'again')}</span></button>
      <button className="ln-btn ln-btn-hard" onClick={() => onGrade(cardId, 'hard')}>Schwer<span className="ln-btn-preview">{previewLabel(oldSrs, 'hard')}</span></button>
      <button className="ln-btn ln-btn-good" onClick={() => onGrade(cardId, 'good')}>Gut<span className="ln-btn-preview">{previewLabel(oldSrs, 'good')}</span></button>
      <button className="ln-btn ln-btn-easy" onClick={() => onGrade(cardId, 'easy')}>Leicht<span className="ln-btn-preview">{previewLabel(oldSrs, 'easy')}</span></button>
    </div>
  );
}
function speakGerman(text) {
  try {
    if (!('speechSynthesis' in window)) return false;
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'de-DE'; utter.rate = 0.92;
    const voices = window.speechSynthesis.getVoices();
    const deVoice = voices.find(v => v.lang && v.lang.startsWith('de'));
    if (deVoice) utter.voice = deVoice;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
    return true;
  } catch (e) { return false; }
}

/* =========================================================================
   CARD TYPE VIEWS
========================================================================= */
function VocabularyCardView({ card, progress, onGrade, onOpenNode }) {
  const node = nodeById(card.nodeId);
  const [flipped, setFlipped] = useState(false);
  if (!node) return null;
  return (
    <>
      <div className="ln-card" onClick={() => setFlipped(f => !f)}>
        <div className={`ln-card-inner ${flipped ? 'is-flipped' : ''}`}>
          <div className="ln-card-face ln-card-front">
            <div className="ln-face-row">
              <GenderBadge gender={node.article} />
              <button className="ln-info-btn" onClick={(e) => { e.stopPropagation(); onOpenNode(node.id); }}>\u24d8</button>
            </div>
            <div className="ln-term">{node.lemma}</div>
            <div className="ln-hint">Tippen zum Umdrehen \u00b7 tap to flip</div>
          </div>
          <div className="ln-card-face ln-card-back">
            <div className="ln-translation">{node.translation}</div>
            {node.plural && <div className="ln-meta">Plural: {node.plural}</div>}
            <div className="ln-example"><div className="ln-example-de">{node.example_de}</div><div className="ln-example-en">{node.example_en}</div></div>
            <MasteryDots reps={progress.cards[card.id]?.reps} />
          </div>
        </div>
      </div>
      {flipped && <GradeButtons cardId={card.id} oldSrs={progress.cards[card.id]} onGrade={onGrade} />}
    </>
  );
}

function SentenceCardView({ card, progress, onGrade }) {
  const [flipped, setFlipped] = useState(false);
  const fromLabel = card.direction === 'en-de' ? 'EN \u2192 DE' : 'DE \u2192 EN';
  return (
    <>
      <div className="ln-card" onClick={() => setFlipped(f => !f)}>
        <div className={`ln-card-inner ${flipped ? 'is-flipped' : ''}`}>
          <div className="ln-card-face ln-card-front">
            <div className="ln-eyebrow-sm">{fromLabel}</div>
            <div className="ln-sentence">{card.prompt}</div>
            <div className="ln-hint">Im Kopf \u00fcbersetzen, dann umdrehen</div>
          </div>
          <div className="ln-card-face ln-card-back">
            <div className="ln-eyebrow-sm">L\u00f6sung</div>
            <div className="ln-sentence">{card.answer}</div>
          </div>
        </div>
      </div>
      {flipped && <GradeButtons cardId={card.id} oldSrs={progress.cards[card.id]} onGrade={onGrade} />}
    </>
  );
}

function GrammarCardView({ card, progress, onGrade }) {
  const [choice, setChoice] = useState(null);
  const [revealed, setRevealed] = useState(false);
  const [typed, setTyped] = useState('');
  const isMC = card.mode === 'choose-article' || card.mode === 'identify-case';
  return (
    <div className="ln-panel">
      <div className="ln-eyebrow-sm">{card.mode === 'identify-case' ? 'Fall bestimmen' : card.mode === 'choose-article' ? 'Artikel w\u00e4hlen' : card.mode === 'conjugate' ? 'Konjugieren' : 'L\u00fccke f\u00fcllen'}</div>
      <div className="ln-sentence">{card.prompt}</div>
      {card.question && <div className="ln-question">{card.question}</div>}
      {isMC ? (
        <div className="ln-mc-row">
          {card.options.map(opt => (
            <button key={opt} className={`ln-mc-btn ${choice === opt ? (opt === card.answer ? 'ln-mc-correct' : 'ln-mc-wrong') : ''} ${revealed && opt === card.answer ? 'ln-mc-correct' : ''}`}
              onClick={() => { setChoice(opt); setRevealed(true); }}>{opt}</button>
          ))}
        </div>
      ) : (
        <>
          <input className="ln-input" placeholder="Antwort eingeben \u2026" value={typed} onChange={e => setTyped(e.target.value)} disabled={revealed} />
          {!revealed && <button className="ln-reveal-btn" onClick={() => setRevealed(true)}>Antwort zeigen</button>}
        </>
      )}
      {revealed && (
        <div className="ln-explanation">
          <div className="ln-correct-answer">L\u00f6sung: {card.answer}</div>
          <div className="ln-explanation-text">{card.explanation}</div>
        </div>
      )}
      {revealed && <GradeButtons cardId={card.id} oldSrs={progress.cards[card.id]} onGrade={onGrade} />}
    </div>
  );
}

function SpeakingCardView({ card, progress, onGrade }) {
  const [phase, setPhase] = useState('idle');
  const [secondsLeft, setSecondsLeft] = useState(card.seconds);
  useEffect(() => {
    if (phase !== 'running') return;
    if (secondsLeft <= 0) { setPhase('done'); return; }
    const t = setTimeout(() => setSecondsLeft(s => s - 1), 1000);
    return () => clearTimeout(t);
  }, [phase, secondsLeft]);
  return (
    <div className="ln-panel">
      <div className="ln-eyebrow-sm">Sprechen \u00b7 {card.seconds}s</div>
      <div className="ln-sentence">{card.prompt}</div>
      {phase === 'idle' && <button className="ln-reveal-btn" onClick={() => { setSecondsLeft(card.seconds); setPhase('running'); }}>Start</button>}
      {phase === 'running' && (
        <div className="ln-timer">
          <div className="ln-timer-num">{secondsLeft}</div>
          <button className="ln-reveal-btn ln-secondary" onClick={() => setPhase('done')}>Fertig / \u00fcberspringen</button>
        </div>
      )}
      {phase === 'done' && (
        <div className="ln-explanation">
          <div className="ln-eyebrow-sm">Musterantwort</div>
          <div className="ln-explanation-text">{card.modelAnswer}</div>
        </div>
      )}
      {phase === 'done' && <GradeButtons cardId={card.id} oldSrs={progress.cards[card.id]} onGrade={onGrade} />}
    </div>
  );
}

function WritingCardView({ card, progress, onGrade }) {
  const [text, setText] = useState('');
  const [revealed, setRevealed] = useState(false);
  return (
    <div className="ln-panel">
      <div className="ln-eyebrow-sm">Schreiben</div>
      <div className="ln-sentence">{card.prompt}</div>
      <textarea className="ln-textarea" placeholder="Schreib deine Antwort hier \u2026" value={text} onChange={e => setText(e.target.value)} />
      {!revealed && <button className="ln-reveal-btn" onClick={() => setRevealed(true)}>Musterantwort zeigen</button>}
      {revealed && <div className="ln-explanation"><div className="ln-eyebrow-sm">Musterantwort</div><div className="ln-explanation-text">{card.modelAnswer}</div></div>}
      {revealed && <GradeButtons cardId={card.id} oldSrs={progress.cards[card.id]} onGrade={onGrade} />}
    </div>
  );
}

function ListeningCardView({ card, progress, onGrade }) {
  const [played, setPlayed] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [typed, setTyped] = useState('');
  return (
    <div className="ln-panel">
      <div className="ln-eyebrow-sm">H\u00f6ren</div>
      <button className="ln-play-btn" onClick={() => { const ok = speakGerman(card.textToSpeak); setPlayed(ok || true); }}>\u25b6 Anh\u00f6ren</button>
      {!played && <div className="ln-hint">Falls kein Ton kommt, unterst\u00fctzt dieser Browser evtl. keine Sprachausgabe.</div>}
      <input className="ln-input" placeholder="Was h\u00f6rst du? \u2026" value={typed} onChange={e => setTyped(e.target.value)} disabled={revealed} />
      {!revealed && <button className="ln-reveal-btn" onClick={() => setRevealed(true)}>Antwort zeigen</button>}
      {revealed && <div className="ln-explanation"><div className="ln-correct-answer">{card.answer}</div><div className="ln-explanation-text">{card.translation}</div></div>}
      {revealed && <GradeButtons cardId={card.id} oldSrs={progress.cards[card.id]} onGrade={onGrade} />}
    </div>
  );
}

function CardRenderer({ card, progress, onGrade, onOpenNode }) {
  switch (card.type) {
    case 'vocab': return <VocabularyCardView card={card} progress={progress} onGrade={onGrade} onOpenNode={onOpenNode} />;
    case 'sentence': return <SentenceCardView card={card} progress={progress} onGrade={onGrade} />;
    case 'grammar': return <GrammarCardView card={card} progress={progress} onGrade={onGrade} />;
    case 'speaking': return <SpeakingCardView card={card} progress={progress} onGrade={onGrade} />;
    case 'writing': return <WritingCardView card={card} progress={progress} onGrade={onGrade} />;
    case 'listening': return <ListeningCardView card={card} progress={progress} onGrade={onGrade} />;
    default: return null;
  }
}

/* =========================================================================
   REVIEW / BROWSE / NODE DETAIL / STATS VIEWS
========================================================================= */
function TagFilterBar({ selectedTags, toggleTag, clearTags }) {
  return (
    <div className="ln-filterbar">
      <button className={`ln-chip ${selectedTags.size === 0 ? 'ln-chip-active' : ''}`} onClick={clearTags}>Alle</button>
      {TAG_META.map(t => <TagChip key={t.name} tag={t.name} active={selectedTags.has(t.name)} onClick={() => toggleTag(t.name)} />)}
    </div>
  );
}

function ReviewView({ progress, onGrade, selectedTags, toggleTag, clearTags, onOpenNode }) {
  const [queue, setQueue] = useState([]);
  const selectedKey = Array.from(selectedTags).sort().join(',');

  useEffect(() => {
    const today = todayStr();
    const pool = CARDS.filter(c => selectedTags.size === 0 || c.tags.some(t => selectedTags.has(t)));
    const due = pool.filter(c => progress.cards[c.id] && progress.cards[c.id].due <= today);
    const fresh = pool.filter(c => !progress.cards[c.id]).slice(0, NEW_CARD_LIMIT);
    const combined = [...due, ...fresh].map(c => c.id);
    for (let i = combined.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [combined[i], combined[j]] = [combined[j], combined[i]]; }
    setQueue(combined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

  const currentCard = queue.length > 0 ? CARDS.find(c => c.id === queue[0]) : null;

  const handleGrade = (cardId, grade) => {
    onGrade(cardId, grade);
    setQueue(q => { const rest = q.slice(1); return grade === 'again' ? [...rest, q[0]] : rest; });
  };

  return (
    <div className="ln-view">
      <TagFilterBar selectedTags={selectedTags} toggleTag={toggleTag} clearTags={clearTags} />
      {currentCard ? (
        <div className="ln-stage">
          <div className="ln-tagrow">{currentCard.tags.map(t => <span key={t} className="ln-minitag">{t}</span>)}</div>
          <CardRenderer card={currentCard} progress={progress} onGrade={handleGrade} onOpenNode={onOpenNode} />
        </div>
      ) : (
        <div className="ln-complete"><h2>F\u00fcr heute geschafft \ud83c\udf89</h2><p>No cards due for this filter right now.</p></div>
      )}
    </div>
  );
}

function BrowseView({ onOpenNode }) {
  return (
    <div className="ln-view">
      <div className="ln-eyebrow-sm" style={{margin: '4px 0 12px'}}>{NODES.length} W\u00f6rter</div>
      <div className="ln-nodelist">
        {NODES.map(n => (
          <button key={n.id} className="ln-noderow" onClick={() => onOpenNode(n.id)}>
            <GenderBadge gender={n.article} />
            <div className="ln-noderow-text"><div className="ln-noderow-lemma">{n.lemma}</div><div className="ln-noderow-en">{n.translation}</div></div>
            <span className="ln-chevron">\u203a</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function NodeDetailModal({ nodeId, progress, onClose, onOpenNode, onStartFocusedReview }) {
  const node = nodeById(nodeId);
  if (!node) return null;
  const vocabCardId = `v_${node.id}`;
  const speakingCard = speakingCards.find(c => c.nodeId === node.id) || speakingCards.find(c => c.tags.some(t => node.tags.includes(t)));
  const writingCard = writingCards.find(c => c.nodeId === node.id);
  const grammarCard = grammarCards.find(c => c.nodeId === node.id);
  return (
    <div className="ln-modal-backdrop" onClick={onClose}>
      <div className="ln-modal" onClick={e => e.stopPropagation()}>
        <button className="ln-modal-close" onClick={onClose}>\u2715</button>
        <GenderBadge gender={node.article} />
        <h2 className="ln-modal-title">{node.lemma}</h2>
        <div className="ln-modal-translation">{node.translation}</div>
        {node.plural && <div className="ln-meta">Plural: {node.plural}</div>}
        <div className="ln-example" style={{margin: '14px 0'}}><div className="ln-example-de">{node.example_de}</div><div className="ln-example-en">{node.example_en}</div></div>
        <MasteryDots reps={progress.cards[vocabCardId]?.reps} />

        {node.grammarNotes && (<><div className="ln-section-label">Grammatik</div><p className="ln-section-text">{node.grammarNotes}</p></>)}
        {node.collocations && (<><div className="ln-section-label">Kollokationen</div><div className="ln-tagrow">{node.collocations.map(c => <span key={c} className="ln-minitag">{c}</span>)}</div></>)}
        {node.relatedNodeIds && node.relatedNodeIds.length > 0 && (
          <>
            <div className="ln-section-label">Verwandte W\u00f6rter</div>
            <div className="ln-tagrow">{node.relatedNodeIds.map(rid => { const rn = nodeById(rid); return rn ? <button key={rid} className="ln-minitag ln-minitag-link" onClick={() => onOpenNode(rid)}>{rn.lemma}</button> : null; })}</div>
          </>
        )}
        {grammarCard && (<><div className="ln-section-label">Grammatik-Check</div><p className="ln-section-text">{grammarCard.prompt}</p></>)}
        {speakingCard && (<><div className="ln-section-label">Sprechen</div><p className="ln-section-text">{speakingCard.prompt}</p></>)}
        {writingCard && (<><div className="ln-section-label">Schreiben</div><p className="ln-section-text">{writingCard.prompt}</p></>)}

        <button className="ln-reveal-btn" style={{marginTop: '18px'}} onClick={() => onStartFocusedReview(node.tags[0])}>Mini-Quiz starten \u2192</button>
      </div>
    </div>
  );
}

function StatsView({ progress }) {
  const totalReviews = progress.totals.reviews;
  const retention = totalReviews > 0 ? Math.round((progress.totals.correct / totalReviews) * 100) : 0;
  const cardsLearned = Object.values(progress.cards).filter(c => c.reps >= 1).length;
  const vocabLearned = vocabCards.filter(c => (progress.cards[c.id]?.reps ?? 0) >= 1).length;

  const weakEntries = Object.entries(progress.tagScores).filter(([, d]) => d.count >= 2).sort((a, b) => a[1].score - b[1].score);
  const weakTags = weakEntries.slice(0, 5);
  const weakGrammar = weakEntries.filter(([t]) => tagCategory(t) === 'grammar').slice(0, 5);

  const dim = (key) => progress.dimensionScores[key] ? Math.round(progress.dimensionScores[key].score * 100) : null;

  return (
    <div className="ln-view">
      <div className="ln-stats-grid">
        <div className="ln-stat-tile"><div className="ln-stat-num">{cardsLearned}</div><div className="ln-stat-label">Karten gelernt</div></div>
        <div className="ln-stat-tile"><div className="ln-stat-num">{progress.streak} \ud83d\udd25</div><div className="ln-stat-label">Serie</div></div>
        <div className="ln-stat-tile"><div className="ln-stat-num">{retention}%</div><div className="ln-stat-label">Retention</div></div>
        <div className="ln-stat-tile"><div className="ln-stat-num">{vocabLearned}</div><div className="ln-stat-label">Vokabeln</div></div>
        <div className="ln-stat-tile"><div className="ln-stat-num">{progress.totals.speakingCount}</div><div className="ln-stat-label">Sprechen ge\u00fcbt</div></div>
        <div className="ln-stat-tile"><div className="ln-stat-num">{totalReviews}</div><div className="ln-stat-label">Wiederholungen</div></div>
      </div>

      <div className="ln-section-label">Dimensionen</div>
      <div className="ln-dim-row">
        {['recognition', 'production', 'grammar'].map(k => (
          <div key={k} className="ln-dim-tile">
            <div className="ln-dim-label">{k === 'recognition' ? 'Erkennen' : k === 'production' ? 'Produktion' : 'Grammatik'}</div>
            <div className="ln-dim-bar"><div className="ln-dim-fill" style={{ width: `${dim(k) ?? 0}%` }} /></div>
            <div className="ln-dim-num">{dim(k) === null ? '\u2014' : `${dim(k)}%`}</div>
          </div>
        ))}
      </div>

      {weakTags.length > 0 && (<><div className="ln-section-label">Schwache Tags</div><div className="ln-tagrow">{weakTags.map(([t, d]) => <span key={t} className="ln-minitag ln-minitag-weak">{t} \u00b7 {Math.round(d.score*100)}%</span>)}</div></>)}
      {weakGrammar.length > 0 && (<><div className="ln-section-label">Schwache Grammatik</div><div className="ln-tagrow">{weakGrammar.map(([t, d]) => <span key={t} className="ln-minitag ln-minitag-weak">{t} \u00b7 {Math.round(d.score*100)}%</span>)}</div></>)}
    </div>
  );
}

function BottomNav({ active, setActive }) {
  const items = [{ key: 'review', label: 'Review' }, { key: 'browse', label: 'Browse' }, { key: 'stats', label: 'Stats' }];
  return (
    <div className="ln-bottomnav">
      {items.map(it => <button key={it.key} className={`ln-navbtn ${active === it.key ? 'ln-navbtn-active' : ''}`} onClick={() => setActive(it.key)}>{it.label}</button>)}
    </div>
  );
}

/* =========================================================================
   APP ROOT
========================================================================= */
function GermanLearningSystem() {
  const [loaded, setLoaded] = useState(false);
  const [progress, setProgress] = useState({ cards: {}, tagScores: {}, dimensionScores: {}, totals: { reviews: 0, correct: 0, speakingCount: 0 }, streak: 0, lastActiveDate: null });
  const [activeTab, setActiveTab] = useState('review');
  const [selectedTags, setSelectedTags] = useState(new Set());
  const [openNodeId, setOpenNodeId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let data = { cards: {}, tagScores: {}, dimensionScores: {}, totals: { reviews: 0, correct: 0, speakingCount: 0 }, streak: 0, lastActiveDate: null };
      try {
        const result = await storage.get(STORAGE_KEY);
        if (result?.value) data = { ...data, ...JSON.parse(result.value) };
      } catch (e) { /* first visit */ }
      const today = todayStr();
      let newStreak = data.streak;
      if (data.lastActiveDate !== today) {
        newStreak = (data.lastActiveDate && daysBetween(data.lastActiveDate, today) === 1) ? data.streak + 1 : 1;
      }
      const next = { ...data, streak: newStreak, lastActiveDate: today };
      if (!cancelled) { setProgress(next); setLoaded(true); }
      try { await storage.set(STORAGE_KEY, JSON.stringify(next)); } catch (e) {}
    })();
    return () => { cancelled = true; };
  }, []);

  const persist = useCallback(async (next) => { try { await storage.set(STORAGE_KEY, JSON.stringify(next)); } catch (e) {} }, []);

  const onGrade = useCallback((cardId, grade) => {
    setProgress(prev => {
      const card = CARDS.find(c => c.id === cardId);
      const updatedSrs = nextSrsState(prev.cards[cardId], grade);
      const gv = gradeValue(grade);
      const newTagScores = { ...prev.tagScores };
      card.tags.forEach(t => { newTagScores[t] = emaUpdate(newTagScores[t], gv); });
      const newDimScores = { ...prev.dimensionScores, [card.dimension]: emaUpdate(prev.dimensionScores[card.dimension], gv) };
      const next = {
        ...prev,
        cards: { ...prev.cards, [cardId]: updatedSrs },
        tagScores: newTagScores,
        dimensionScores: newDimScores,
        totals: { reviews: prev.totals.reviews + 1, correct: prev.totals.correct + (grade !== 'again' ? 1 : 0), speakingCount: prev.totals.speakingCount + (card.type === 'speaking' ? 1 : 0) },
      };
      persist(next);
      return next;
    });
  }, [persist]);

  const toggleTag = (tag) => setSelectedTags(prev => { const next = new Set(prev); next.has(tag) ? next.delete(tag) : next.add(tag); return next; });
  const clearTags = () => setSelectedTags(new Set());
  const onStartFocusedReview = (tag) => { setSelectedTags(new Set([tag])); setOpenNodeId(null); setActiveTab('review'); };

  if (!loaded) return <div className="ln-app"><LnStyles /><div className="ln-loading">Lade Fortschritt\u2026</div></div>;

  return (
    <div className="ln-app">
      <LnStyles />
      <div className="ln-header">
        <div className="ln-eyebrow">A2 \u00b7 Lernsystem</div>
        <h1 className="ln-title">{activeTab === 'review' ? 'Review' : activeTab === 'browse' ? 'W\u00f6rter' : 'Statistik'}</h1>
      </div>

      {activeTab === 'review' && <ReviewView progress={progress} onGrade={onGrade} selectedTags={selectedTags} toggleTag={toggleTag} clearTags={clearTags} onOpenNode={setOpenNodeId} />}
      {activeTab === 'browse' && <BrowseView onOpenNode={setOpenNodeId} />}
      {activeTab === 'stats' && <StatsView progress={progress} />}

      <BottomNav active={activeTab} setActive={setActiveTab} />
      {openNodeId && <NodeDetailModal nodeId={openNodeId} progress={progress} onClose={() => setOpenNodeId(null)} onOpenNode={setOpenNodeId} onStartFocusedReview={onStartFocusedReview} />}
    </div>
  );
}

function LnStyles() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');
      .ln-app { --paper:#F2F0EA; --ink:#1A1917; --ink-soft:#6B6760; --line:#D9D5CB; --cobalt:#2B4C9B; --brick:#B8432C; --mustard:#DDA422; --sage:#4C7A53; --card-bg:#FBFAF6;
        font-family:'IBM Plex Sans',sans-serif; background:var(--paper); color:var(--ink); min-height:100%; padding:20px 14px 84px; box-sizing:border-box; display:flex; flex-direction:column; align-items:center; position:relative; }
      .ln-app * { box-sizing:border-box; }
      .ln-header { width:100%; max-width:480px; margin-bottom:14px; }
      .ln-eyebrow { font-family:'IBM Plex Mono',monospace; font-size:11px; letter-spacing:.12em; color:var(--ink-soft); text-transform:uppercase; margin-bottom:4px; }
      .ln-title { font-family:'Space Grotesk',sans-serif; font-weight:700; font-size:26px; margin:0; }
      .ln-view { width:100%; max-width:480px; display:flex; flex-direction:column; align-items:center; }
      .ln-filterbar { display:flex; gap:6px; flex-wrap:wrap; width:100%; margin-bottom:16px; }
      .ln-chip { font-family:'IBM Plex Mono',monospace; font-size:11.5px; padding:6px 11px; border-radius:999px; border:1px solid var(--line); background:transparent; color:var(--ink-soft); cursor:pointer; }
      .ln-chip-active { background:var(--ink); color:var(--paper); border-color:var(--ink); }
      .ln-chip-grammar.ln-chip-active { background:var(--cobalt); border-color:var(--cobalt); }
      .ln-chip-skill.ln-chip-active { background:var(--sage); border-color:var(--sage); }
      .ln-stage { width:100%; display:flex; flex-direction:column; align-items:center; }
      .ln-tagrow { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:10px; width:100%; }
      .ln-minitag { font-family:'IBM Plex Mono',monospace; font-size:10.5px; color:var(--ink-soft); border:1px solid var(--line); border-radius:4px; padding:3px 7px; background:none; cursor:default; }
      .ln-minitag-link { cursor:pointer; color:var(--cobalt); border-color:var(--cobalt); }
      .ln-minitag-weak { color:var(--brick); border-color:var(--brick); }
      .ln-card { width:100%; aspect-ratio:4/3; perspective:1400px; cursor:pointer; }
      .ln-card-inner { position:relative; width:100%; height:100%; transition:transform .5s cubic-bezier(.2,.7,.3,1); transform-style:preserve-3d; }
      .ln-card-inner.is-flipped { transform:rotateY(180deg); }
      .ln-card-face { position:absolute; inset:0; backface-visibility:hidden; border-radius:6px; border:1.5px solid var(--ink); background:var(--card-bg); display:flex; flex-direction:column; padding:20px; }
      .ln-card-back { transform:rotateY(180deg); }
      .ln-face-row { display:flex; justify-content:space-between; align-items:flex-start; }
      .ln-info-btn { background:none; border:1px solid var(--line); border-radius:50%; width:26px; height:26px; cursor:pointer; color:var(--ink-soft); font-size:14px; }
      .ln-badge { display:inline-flex; align-items:center; gap:6px; align-self:flex-start; font-family:'IBM Plex Mono',monospace; font-size:11px; letter-spacing:.06em; padding:4px 9px 4px 6px; border-radius:4px; color:var(--paper); }
      .ln-badge-der { background:var(--cobalt); } .ln-badge-die { background:var(--brick); } .ln-badge-das { background:var(--mustard); color:var(--ink); } .ln-badge-verb { background:var(--ink-soft); }
      .ln-shape { width:10px; height:10px; display:inline-block; }
      .ln-shape-square { background:currentColor; } .ln-shape-circle { background:currentColor; border-radius:50%; }
      .ln-shape-triangle { width:0; height:0; background:none; border-left:5px solid transparent; border-right:5px solid transparent; border-bottom:9px solid currentColor; }
      .ln-term { font-family:'Space Grotesk',sans-serif; font-weight:700; font-size:26px; margin:auto 0 4px; }
      .ln-hint { font-size:12px; color:var(--ink-soft); margin-top:auto; }
      .ln-translation { font-family:'Space Grotesk',sans-serif; font-weight:700; font-size:22px; margin-bottom:10px; }
      .ln-meta { font-size:12.5px; color:var(--ink-soft); margin-bottom:8px; }
      .ln-example { font-size:14px; line-height:1.5; }
      .ln-example-de { color:var(--ink); margin-bottom:3px; } .ln-example-en { color:var(--ink-soft); font-size:13px; }
      .ln-mastery { display:flex; align-items:center; gap:5px; margin-top:auto; }
      .ln-dot { width:7px; height:7px; border-radius:50%; border:1.2px solid var(--ink-soft); }
      .ln-dot-filled { background:var(--sage); border-color:var(--sage); }
      .ln-mastery-label { font-family:'IBM Plex Mono',monospace; font-size:10.5px; color:var(--ink-soft); margin-left:4px; }
      .ln-eyebrow-sm { font-family:'IBM Plex Mono',monospace; font-size:11px; letter-spacing:.08em; color:var(--ink-soft); text-transform:uppercase; margin-bottom:8px; }
      .ln-sentence { font-family:'Space Grotesk',sans-serif; font-weight:600; font-size:19px; line-height:1.4; }
      .ln-panel { width:100%; border:1.5px solid var(--ink); border-radius:6px; background:var(--card-bg); padding:20px; display:flex; flex-direction:column; gap:12px; }
      .ln-question { font-size:13.5px; color:var(--ink-soft); }
      .ln-mc-row { display:flex; gap:8px; flex-wrap:wrap; }
      .ln-mc-btn { border:1.5px solid var(--line); background:transparent; border-radius:5px; padding:9px 16px; font-family:'IBM Plex Sans',sans-serif; font-weight:600; font-size:13.5px; cursor:pointer; }
      .ln-mc-correct { border-color:var(--sage); background:var(--sage); color:var(--paper); }
      .ln-mc-wrong { border-color:var(--brick); background:var(--brick); color:var(--paper); }
      .ln-input { width:100%; border:1.5px solid var(--line); border-radius:5px; padding:10px 12px; font-family:'IBM Plex Sans',sans-serif; font-size:14px; background:var(--paper); }
      .ln-textarea { width:100%; min-height:90px; border:1.5px solid var(--line); border-radius:5px; padding:10px 12px; font-family:'IBM Plex Sans',sans-serif; font-size:14px; background:var(--paper); resize:vertical; }
      .ln-reveal-btn { border:1.5px solid var(--ink); background:var(--ink); color:var(--paper); border-radius:5px; padding:11px; font-weight:600; font-size:13.5px; cursor:pointer; }
      .ln-reveal-btn.ln-secondary { background:transparent; color:var(--ink); margin-top:8px; }
      .ln-play-btn { border:1.5px solid var(--cobalt); color:var(--cobalt); background:transparent; border-radius:5px; padding:11px; font-weight:600; font-size:13.5px; cursor:pointer; align-self:flex-start; }
      .ln-timer { display:flex; flex-direction:column; align-items:center; gap:8px; }
      .ln-timer-num { font-family:'IBM Plex Mono',monospace; font-size:42px; font-weight:500; }
      .ln-explanation { border-top:1px solid var(--line); padding-top:10px; }
      .ln-correct-answer { font-weight:600; margin-bottom:4px; }
      .ln-explanation-text { font-size:13.5px; color:var(--ink-soft); line-height:1.5; }
      .ln-grades { width:100%; display:grid; grid-template-columns:repeat(4,1fr); gap:8px; margin-top:14px; }
      .ln-btn { border:1.5px solid var(--ink); background:var(--paper); border-radius:5px; padding:10px 4px; font-weight:600; font-size:13px; cursor:pointer; display:flex; flex-direction:column; align-items:center; gap:3px; }
      .ln-btn-again { border-color:var(--brick); color:var(--brick); } .ln-btn-hard { border-color:var(--mustard); color:#8a6a10; }
      .ln-btn-good { border-color:var(--cobalt); color:var(--cobalt); } .ln-btn-easy { border-color:var(--sage); color:var(--sage); }
      .ln-btn-preview { font-family:'IBM Plex Mono',monospace; font-size:10.5px; font-weight:400; opacity:.75; }
      .ln-complete { width:100%; border:1.5px solid var(--ink); border-radius:6px; background:var(--card-bg); padding:30px 20px; text-align:center; }
      .ln-nodelist { width:100%; display:flex; flex-direction:column; gap:8px; }
      .ln-noderow { display:flex; align-items:center; gap:12px; border:1px solid var(--line); border-radius:6px; padding:12px 14px; background:var(--card-bg); cursor:pointer; text-align:left; }
      .ln-noderow-text { flex:1; }
      .ln-noderow-lemma { font-family:'Space Grotesk',sans-serif; font-weight:700; font-size:15px; }
      .ln-noderow-en { font-size:12.5px; color:var(--ink-soft); }
      .ln-chevron { color:var(--ink-soft); }
      .ln-stats-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; width:100%; margin-bottom:20px; }
      .ln-stat-tile { border:1px solid var(--line); border-radius:6px; padding:14px 8px; text-align:center; background:var(--card-bg); }
      .ln-stat-num { font-family:'Space Grotesk',sans-serif; font-weight:700; font-size:20px; }
      .ln-stat-label { font-size:10.5px; color:var(--ink-soft); margin-top:2px; }
      .ln-section-label { font-family:'IBM Plex Mono',monospace; font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:var(--ink-soft); margin:14px 0 6px; width:100%; }
      .ln-section-text { font-size:13.5px; line-height:1.5; width:100%; margin:0; }
      .ln-dim-row { display:flex; gap:10px; width:100%; }
      .ln-dim-tile { flex:1; }
      .ln-dim-label { font-size:11.5px; color:var(--ink-soft); margin-bottom:4px; }
      .ln-dim-bar { height:6px; background:var(--line); border-radius:3px; overflow:hidden; }
      .ln-dim-fill { height:100%; background:var(--cobalt); }
      .ln-dim-num { font-family:'IBM Plex Mono',monospace; font-size:11px; margin-top:3px; }
      .ln-bottomnav { position:fixed; bottom:0; left:0; right:0; display:flex; border-top:1.5px solid var(--ink); background:var(--paper); max-width:520px; margin:0 auto; }
      .ln-navbtn { flex:1; padding:14px 0; background:none; border:none; font-family:'IBM Plex Mono',monospace; font-size:12.5px; letter-spacing:.05em; color:var(--ink-soft); cursor:pointer; }
      .ln-navbtn-active { color:var(--ink); font-weight:600; border-top:2px solid var(--ink); margin-top:-1.5px; padding-top:12.5px; }
      .ln-modal-backdrop { position:fixed; inset:0; background:rgba(26,25,23,.5); display:flex; align-items:flex-end; justify-content:center; z-index:50; }
      .ln-modal { width:100%; max-width:480px; max-height:85vh; overflow-y:auto; background:var(--paper); border-radius:14px 14px 0 0; padding:24px 20px 32px; position:relative; }
      .ln-modal-close { position:absolute; top:16px; right:16px; background:none; border:none; font-size:18px; color:var(--ink-soft); cursor:pointer; }
      .ln-modal-title { font-family:'Space Grotesk',sans-serif; font-weight:700; font-size:24px; margin:8px 0 2px; }
      .ln-modal-translation { font-size:15px; color:var(--ink-soft); margin-bottom:8px; }
      .ln-loading { font-family:'IBM Plex Mono',monospace; font-size:13px; color:var(--ink-soft); padding:60px 0; }
      @media (max-width:420px) { .ln-title { font-size:22px; } .ln-term { font-size:22px; } }
    `}</style>
  );
}


ReactDOM.createRoot(document.getElementById('root')).render(<GermanLearningSystem />);
