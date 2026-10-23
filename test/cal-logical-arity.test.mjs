// test/cal-logical-arity.test.mjs — SONAR2026.10 rejects (&& a b c) with CAL Error 003.
//
// Keep logical expressions binary for the native CAL interpreter. The
// deleteNotes generator emitted (&& kind (>= lo) (<= hi)) with three operands,
// and the real 0..0 run was refused with "CAL Error 003: &". The fix nests the
// comparison pair: (&& kind (&& (>= lo) (<= hi))).
//
// This test parses every generated form with a small s-expression reader and
// asserts the arity of every && / || node. It is host-free: it only generates
// source text and never claims SONAR accepted anything.

import test from 'node:test';
import assert from 'node:assert/strict';
import { GENERATORS, deleteNotesSource } from '../lib/cal-script.js';

// Arguments that let every generator run without touching the host. addNotes
// needs a non-zero interval or it throws NO_INTERVALS by design.
const ARGS = {
  setVelocity: { velocity: 64 },
  scaleVelocity: { percent: 50 },
  addNotes: { intervals: [12] },
  deleteNotes: { minKey: 0, maxKey: 127 },
  transpose: { semitones: -5 },
  setDuration: { percent: 200 },
  queryNotes: { trackIndex: 0 },
  dumpNotes: {},
  renameTrack: { trackIndex: 0, name: 'X' },
  setTrackMute: { trackIndex: 0, mute: true },
  setTrackRouting: { trackIndex: 0, channel: 1 },
};

const isOpen = (c) => c === '(' || c === '[';
const isClose = (c) => c === ')' || c === ']';

/** Depth-0 comment text removal, leaving quoted strings intact. */
function stripComments(src) {
  let out = '';
  let inString = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    const next = src[i + 1];
    if (inString) {
      out += c;
      if (c === '"') inString = false;
      continue;
    }
    if (lineComment) {
      if (c === '\n') { lineComment = false; out += c; }
      continue;
    }
    if (blockComment) {
      if (c === '*' && next === '/') { blockComment = false; i += 1; }
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === ';') { lineComment = true; continue; }
    if (c === '/' && next === '*') { blockComment = true; i += 1; continue; }
    out += c;
  }
  return out;
}

/** Tokenise CAL-ish text: parens/brackets and atoms, quoted strings dropped. */
function tokenize(src) {
  const toks = [];
  const text = stripComments(src);
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      i += 1;
      while (i < text.length && text[i] !== '"') i += 1;
      i += 1;
      toks.push({ t: 'str' });
      continue;
    }
    if (isOpen(c) || isClose(c)) { toks.push({ t: 'p', v: c }); i += 1; continue; }
    if (/\s/.test(c)) { i += 1; continue; }
    let j = i;
    while (j < text.length && !/[\s()[\]]/.test(text[j]) && text[j] !== '"') j += 1;
    toks.push({ t: 'atom', v: text.slice(i, j) });
    i = j;
  }
  return toks;
}

/** Parse tokens into nested arrays; returns every top-level form. */
function parseForms(toks) {
  const forms = [];
  const stack = [[]];
  for (const tok of toks) {
    if (tok.t === 'p' && isOpen(tok.v)) {
      const node = [];
      stack[stack.length - 1].push(node);
      stack.push(node);
    } else if (tok.t === 'p' && isClose(tok.v)) {
      assert.ok(stack.length > 1, `unbalanced '${tok.v}' in generated CAL`);
      stack.pop();
    } else {
      stack[stack.length - 1].push(tok.v);
    }
  }
  assert.equal(stack.length, 1, 'unbalanced "(" in generated CAL');
  forms.push(...stack[0]);
  return forms;
}

/** Walk a parsed tree, collecting every (&& ...) / (|| ...) node. */
function logicalNodes(node, seen = []) {
  if (!Array.isArray(node)) return seen;
  if (node[0] === '&&' || node[0] === '||') {
    seen.push({ op: node[0], arity: node.length - 1 });
  }
  for (const child of node) logicalNodes(child, seen);
  return seen;
}

function inspect(src) {
  const forms = parseForms(tokenize(src));
  const nodes = [];
  for (const f of forms) logicalNodes(f, nodes);
  return { forms, nodes };
}

test('every && and || in every generated form has exactly two operands', () => {
  const names = Object.keys(GENERATORS);
  assert.ok(names.length > 0, 'GENERATORS is empty');
  let totalLogical = 0;
  for (const name of names) {
    const src = GENERATORS[name](ARGS[name] ?? {});
    assert.equal(typeof src, 'string', `${name} did not return source text`);
    const { forms, nodes } = inspect(src);
    assert.ok(forms.length > 0, `${name} produced no parseable CAL form`);
    for (const node of nodes) {
      assert.equal(
        node.arity,
        2,
        `${name}: (${node.op} ...) has ${node.arity} operand(s); CAL proves it binary only`,
      );
    }
    totalLogical += nodes.length;
  }
  assert.ok(totalLogical >= 1, 'no logical operator seen across all generators');
});

test('deleteNotes nests the key-range && instead of passing three operands', () => {
  for (const [minKey, maxKey] of [[0, 0], [127, 127], [100, 40]]) {
    const src = deleteNotesSource({ minKey, maxKey });
    const { nodes } = inspect(src);
    assert.ok(nodes.length >= 1, `deleteNotes ${minKey}..${maxKey} emitted no logical operator`);
    for (const node of nodes) {
      assert.equal(node.arity, 2, `deleteNotes ${minKey}..${maxKey}: bad arity ${node.arity}`);
    }
    assert.match(src, /\(&& \(== Event\.Kind NOTE\)/, 'kind test must lead the condition');
    assert.match(src, /\(&& \(>= Note\.Key lo\) \(<= Note\.Key hi\)\)\)/,
      'key range must be a nested binary &&');
    // Normalisation and the delete behaviour must survive the fix.
    const lo = Math.min(minKey, maxKey);
    const hi = Math.max(minKey, maxKey);
    assert.match(src, new RegExp(`\\(int lo ${lo}\\)`), 'lo bound lost');
    assert.match(src, new RegExp(`\\(int hi ${hi}\\)`), 'hi bound lost');
    assert.match(src, /\(delete\)/, 'delete call lost');
  }
});
