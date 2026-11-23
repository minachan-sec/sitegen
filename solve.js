// sitegen: a fast drop-in for makefun-site 1.0.0. run(input) returns exactly the output tree makefun-site's
// build returns for the same input, byte for byte; the internals are written for speed: the Markdown inline
// renderer works on plain runs instead of per character, block lines are classified by character codes instead
// of a battery of regular expressions, slugs are memoised per build, and templates render into a shared array.

const hasOwn = Object.hasOwn;

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_RE_G = /[&<>"']/g;

/**
 * `text` with & < > " and ' escaped (makefun-site's table). Most values hold none of the five and return
 * as they are after one scan; the rest go through the table replace.
 */
function esc(text) {
  if (!ESC_TEST.test(text)) return text;
  return text.replace(ESC_RE_G, (c) => ESCAPES[c]);
}

const SLUG_MAX = 64;

/** The slug of `text`, makefun-site's rule: NFKD, marks dropped, A-Z lowered, runs of other characters one "-". */
function slugifyRaw(text) {
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  // NFKD is the identity on U+0000..U+007F and no combining marks arise from it, so the ASCII path skips both.
  let out = '';
  let gap = false;
  if (ascii) {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === -1) {
        if (out.length > 0) gap = true;
        continue;
      }
      if (gap) {
        out += '-';
        gap = false;
      }
      out += String.fromCharCode(keep);
    }
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        if (out.length > 0) gap = true;
        continue;
      }
      if (gap) {
        out += '-';
        gap = false;
      }
      out += keep;
    }
  }
  if (out.length > SLUG_MAX) out = out.slice(0, SLUG_MAX);
  let end = out.length;
  while (end > 0 && out.charCodeAt(end - 1) === 45) end--;
  if (end !== out.length) out = out.slice(0, end);
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDateRaw(date) {
  const dash1 = date.indexOf('-');
  const dash2 = date.indexOf('-', dash1 + 1);
  const y = date.slice(0, dash1);
  const m = date.slice(dash1 + 1, dash2);
  const d = date.slice(dash2 + 1);
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** Whether `c` (a UTF-16 code unit) is whitespace to JavaScript's \s. */
function isWs(c) {
  if (c <= 32) return c === 32 || (c >= 9 && c <= 13);
  return (
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

/** Whitespace (JavaScript's \s) for code units below 256: \t \n \v \f \r, space, and NBSP. */
const WS_TABLE = new Uint8Array(256);
for (const c of [9, 10, 11, 12, 13, 32, 0xa0]) WS_TABLE[c] = 1;

/** The words of a body: its runs of characters other than whitespace. Branch-free on purpose: whether a
 * character is whitespace flips at every word boundary, which the branch predictor cannot learn, while the
 * arithmetic form (count a word exactly when a non-whitespace character follows a whitespace state) has no
 * branch to miss. Measured ~19 ms per cold run faster than the branching form (interleaved, per-round diffs). */
function wordsOf(text) {
  let count = 0;
  let inRun = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const w = c < 256 ? WS_TABLE[c] : isWs(c) ? 1 : 0;
    const nw = 1 - w;
    count += nw & (1 - inRun);
    inRun = nw;
  }
  return count;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1)
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function isDateRaw(raw) {
  if (raw.length !== 10 || raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) return false;
  for (let i = 0; i < 10; i++) {
    if (i === 4 || i === 7) continue;
    const c = raw.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  const y = Number(raw.slice(0, 4));
  const mo = Number(raw.slice(5, 7));
  const d = Number(raw.slice(8, 10));
  return y >= 1970 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo);
}

function isNameRaw(raw) {
  if (raw.length === 0) return false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

function isSlugRaw(raw) {
  // ^[a-z0-9]+(?:-[a-z0-9]+)*$
  if (raw.length === 0) return false;
  let seg = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 45) {
      if (seg === 0) return false;
      seg = 0;
    } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) seg++;
    else return false;
  }
  return seg > 0;
}

/** One front-matter key's value, or why it is refused (makefun-site's messages, word for word). */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date':
      return isDateRaw(raw)
        ? { value: raw }
        : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.includes('"') || t.includes('[') || t.includes(']'))
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return isNameRaw(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return isSlugRaw(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused.
 * `text` has "\n" line ends. Line ranges are scanned in place; the body is the slice past the closing line.
 */
function parseFrontMatter(text) {
  if (!text.startsWith('---') || (text.length > 3 && text.charCodeAt(3) !== 10)) return { error: 'no front matter' };
  // The line ranges [start, end) of every line, and the index of the closing "---" line.
  const starts = [0];
  const ends = [];
  let close = -1;
  let pos = 0;
  for (;;) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    ends.push(end);
    if (starts.length > 1 && end - pos === 3 && text.startsWith('---', pos)) {
      close = starts.length - 1;
      break;
    }
    if (nl === -1) break;
    pos = nl + 1;
    starts.push(pos);
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = text.slice(starts[i], ends[i]);
    if (isBlank(line) || line.startsWith('#')) continue;
    // "key: value": a key of a-z and _, a colon, then either the end or one space and the value.
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    let raw = null;
    if (k > 0 && line.charCodeAt(k) === 58) {
      if (k + 1 === line.length) raw = '';
      else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2).replace(/[ \t]+$/, '');
    }
    if (raw === null) return { error: `line ${i + 1} is not "key: value"` };
    const key = line.slice(0, k);
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!hasOwn(data, 'title')) return { error: 'no title' };
  const bodyStart = ends[close] + 1;
  return { data, body: bodyStart >= text.length ? '' : text.slice(bodyStart) };
}

// ---------------------------------------------------------------- markdown

/** The characters a backslash escapes, by code unit. */
const ESCAPABLE = new Uint8Array(128);
for (const ch of ['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']) ESCAPABLE[ch.charCodeAt(0)] = 1;

function isEscapable(c) {
  return c < 128 && ESCAPABLE[c] === 1;
}

/** The first index from `from` where `s` holds the code unit `w` (or the pair "**") outside a backslash escape. */
function findUnescaped(s, w, from) {
  const n = s.length;
  if (w === 42) {
    // "**": native jumps between candidate pairs; the slow scan runs only when a backslash intervenes.
    let j = from;
    for (;;) {
      const k = s.indexOf('**', j);
      if (k === -1) return -1;
      const bs = s.indexOf('\\', j);
      if (bs === -1 || bs > k) return k;
      return findUnescapedSlow(s, w, from);
    }
  }
  const k = s.indexOf(String.fromCharCode(w), from);
  if (k === -1) return -1;
  const bs = s.indexOf('\\', from);
  if (bs === -1 || bs > k) return k;
  return findUnescapedSlow(s, w, from);
}

/** findUnescaped by the character scan, for the rare stretch that holds a backslash before the target. */
function findUnescapedSlow(s, w, from) {
  const n = s.length;
  if (w === 42) {
    // "**"
    for (let j = from; j <= n - 2; j++) {
      const c = s.charCodeAt(j);
      if (c === 92 && j + 1 < n && isEscapable(s.charCodeAt(j + 1))) {
        j++;
        continue;
      }
      if (c === 42 && s.charCodeAt(j + 1) === 42) return j;
    }
    return -1;
  }
  for (let j = from; j < n; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < n && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c === w) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  const bs = s.indexOf('\\', from);
  let j = from;
  for (;;) {
    const k = s.indexOf('*', j);
    if (k === -1) return -1;
    if (bs !== -1 && bs < k) return findSingleStarSlow(s, from);
    if (s.charCodeAt(k + 1) === 42) {
      j = k + 2;
      continue;
    }
    return k;
  }
}

/** findSingleStar by the character scan, for the rare stretch that holds a backslash first. */
function findSingleStarSlow(s, from) {
  const n = s.length;
  for (let j = from; j < n; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < n && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

const TRIGGER_RE = /[`*[\\]/;
const TRIGGER_RE_G = /[`*[\\]/g;

/** `s` rendered inline; `link(target)` is a link's href. Plain runs are escaped whole, not per character. */
function inline(s, link) {
  if (!TRIGGER_RE.test(s)) return esc(s);
  const n = s.length;
  let out = '';
  let runStart = 0;
  let i = 0;
  while (i < n) {
    // Jump to the next trigger character (\\, `, * or [); the run before it is plain text.
    TRIGGER_RE_G.lastIndex = i;
    const tm = TRIGGER_RE_G.exec(s);
    const j = tm === null ? n : tm.index;
    if (j === n) break;
    i = j;
    const c = s.charCodeAt(i);
    if (c === 92) {
      if (i + 1 < n && isEscapable(s.charCodeAt(i + 1))) {
        if (i > runStart) out += esc(s.slice(runStart, i));
        const ch = s[i + 1];
        out += ch === '>' ? '&gt;' : ch;
        i += 2;
        runStart = i;
      } else i++;
      continue;
    }
    if (c === 96) {
      const k = s.indexOf('`', i + 1);
      if (k > i + 1) {
        if (i > runStart) out += esc(s.slice(runStart, i));
        out += '<code>' + esc(s.slice(i + 1, k)) + '</code>';
        i = k + 1;
        runStart = i;
      } else i++;
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const k = findUnescaped(s, 42, i + 2);
        if (k > i + 2) {
          if (i > runStart) out += esc(s.slice(runStart, i));
          out += '<strong>' + inline(s.slice(i + 2, k), link) + '</strong>';
          i = k + 2;
          runStart = i;
        } else i += 2;
      } else {
        const k = findSingleStar(s, i + 1);
        if (k > i + 1) {
          if (i > runStart) out += esc(s.slice(runStart, i));
          out += '<em>' + inline(s.slice(i + 1, k), link) + '</em>';
          i = k + 1;
          runStart = i;
        } else i++;
      }
      continue;
    }
    // c === 91, '['
    const k = findUnescaped(s, 93, i + 1);
    const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !hasWs(target)) {
      if (i > runStart) out += esc(s.slice(runStart, i));
      out += '<a href="' + esc(link(target)) + '">' + inline(s.slice(i + 1, k), link) + '</a>';
      i = m + 1;
      runStart = i;
    } else i++;
  }
  if (n > runStart) out += esc(s.slice(runStart, n));
  return out;
}

function hasWs(s) {
  for (let i = 0; i < s.length; i++) if (isWs(s.charCodeAt(i))) return true;
  return false;
}

// Line classification, by character codes (the reference's regexes, restated).

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence-opening line's language, or null. */
function fenceLang(line) {
  if (!line.startsWith('```')) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

function isFenceClose(line) {
  if (!line.startsWith('```')) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
const HEAD_SCRATCH = { depth: 0, text: '' };

function headingOf(line) {
  let depth = 0;
  while (depth < line.length && line.charCodeAt(depth) === 35) depth++;
  if (depth === 0 || depth > 6) return null;
  const c = line.charCodeAt(depth);
  if (c !== 32 && c !== 9) return null;
  let start = depth;
  while (start < line.length) {
    const cc = line.charCodeAt(start);
    if (cc !== 32 && cc !== 9) break;
    start++;
  }
  let end = line.length;
  while (end > start) {
    const cc = line.charCodeAt(end - 1);
    if (cc !== 32 && cc !== 9) break;
    end--;
  }
  if (end === start) return null;
  // The scratch is safe: every caller reads the fields before any other headingOf call.
  HEAD_SCRATCH.depth = depth;
  HEAD_SCRATCH.text = line.slice(start, end);
  return HEAD_SCRATCH;
}

function isHr(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A list item line: { ordered, start, text } or null. */
const ITEM_SCRATCH = { ordered: false, start: 1, text: '' };

function listItemOf(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) {
    // The scratch is safe: every caller reads the fields before any other listItemOf call
    // (renderList copies ordered/start out of `first` before its own loop starts).
    ITEM_SCRATCH.ordered = false;
    ITEM_SCRATCH.start = 1;
    ITEM_SCRATCH.text = line.slice(2);
    return ITEM_SCRATCH;
  }
  let d = 0;
  while (d < line.length) {
    const c = line.charCodeAt(d);
    if (c >= 48 && c <= 57) d++;
    else break;
  }
  if (d >= 1 && d <= 9 && line.charCodeAt(d) === 46 && line.charCodeAt(d + 1) === 32) {
    ITEM_SCRATCH.ordered = true;
    ITEM_SCRATCH.start = Number(line.slice(0, d));
    ITEM_SCRATCH.text = line.slice(d + 2);
    return ITEM_SCRATCH;
  }
  return null;
}

function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  return i >= 2 && i < line.length && !isWs(line.charCodeAt(i));
}

/** A line as paragraphs and items render it: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c !== 32 && c !== 9) break;
    a++;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c !== 32 && c !== 9) break;
    b--;
  }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  if (line.length === 0) return true;
  const c = line.charCodeAt(0);
  if (c !== 32 && c !== 9 && c !== 96 && c !== 35 && c !== 45 && c !== 42) return false;
  return isBlank(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of contents (every
 * level 2 and 3 heading) and its excerpt (the first paragraph's inline HTML, or ""). Lexing and rendering are
 * fused into one pass, dispatched on each line's first character (every block pattern anchors on one).
 */
function renderMarkdown(src, link, slugify) {
  const lines = src.split('\n');
  const n = lines.length;
  const ids = new Set();
  const parts = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (line === '') {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9) {
      if (isBlank(line)) {
        i++;
        continue;
      }
    } else if (c0 === 96) {
      const lang = fenceLang(line);
      if (lang !== null) {
        i++;
        const raw = [];
        while (i < n && !isFenceClose(lines[i])) {
          raw.push(lines[i]);
          i++;
        }
        i++;
        // One esc over the joined block: escaping is per character and '\n' is never escaped.
        const body = raw.length === 0 ? '' : esc(raw.join('\n')) + '\n';
        parts.push('<pre><code' + (lang === '' ? '' : ` class="language-${lang}"`) + '>' + body + '</code></pre>', '\n');
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text), ids);
        const html = inline(heading.text, link);
        parts.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`, '\n');
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHr(line)) {
        parts.push('<hr>', '\n');
        i++;
        continue;
      }
      const item = listItemOf(line);
      if (item !== null) {
        i = renderList(lines, i, item, parts, link);
        continue;
      }
    } else if (c0 === 62) {
      const kept = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i];
        const t = trimLine(l.length > 1 && l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
        if (t !== '') kept.push(t);
        i++;
      }
      parts.push(
        kept.length === 0
          ? '<blockquote>\n</blockquote>'
          : `<blockquote>\n<p>${inline(kept.join('\n'), link)}</p>\n</blockquote>`,
        '\n',
      );
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const item = listItemOf(line);
      if (item !== null) {
        i = renderList(lines, i, item, parts, link);
        continue;
      }
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) {
      body.push(trimLine(lines[i]));
      i++;
    }
    const html = inline(body.length === 1 ? body[0] : body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    parts.push(`<p>${html}</p>`, '\n');
  }
  return { html: parts.join(''), toc, excerpt: excerpt ?? '' };
}

/** A list block starting at lines[i] (whose first item is `first`); returns the index past the block. */
function renderList(lines, i, first, parts, link) {
  const n = lines.length;
  const ordered = first.ordered;
  const start = first.start;
  const items = [];
  while (i < n) {
    const m = listItemOf(lines[i]);
    if (m !== null && m.ordered === ordered) {
      items.push([trimLine(m.text)]);
      i++;
    } else if (isContinued(lines[i])) {
      items[items.length - 1].push(trimLine(lines[i]));
      i++;
    } else break;
  }
  const tag = ordered ? 'ol' : 'ul';
  let block = (ordered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`) + '\n';
  for (const partsOfItem of items) block += `<li>${inline(partsOfItem.length === 1 ? partsOfItem[0] : partsOfItem.join('\n'), link)}</li>\n`;
  block += `</${tag}>`;
  parts.push(block, '\n');
  return i;
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = allSpaceTab(src, lineStart, open) && allSpaceTab(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** Whether src[a..b) is all spaces and tabs (a standalone tag line's padding). */
function allSpaceTab(src, a, b) {
  for (let i = a; i < b; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if'))
          throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  const head = path[0];
  while (s !== null && !hasOwn(s.vars, head)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[head];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** The value of a single name in the scope chain, or undefined. */
function lookupHead(scope, head) {
  let s = scope;
  while (s !== null && !hasOwn(s.vars, head)) s = s.parent;
  return s === null ? undefined : s.vars[head];
}

/** The memo trie leaf marker: a key no resolved value can be. */
const MEMO_LEAF = {};

/** An include: the target template rendered in the current scope, memoised on its free heads' values. */
function renderInclude(name, scope, ctx, depth, out) {
  const entry = ctx.templates.get(name);
  if (entry === undefined || depth >= INCLUDE_DEPTH) return;
  const fh = ctx.freeHeads.get(name);
  if (fh === null || fh === undefined) {
    renderEntry(entry, scope, ctx, depth + 1, out);
    return;
  }
  // The render is a pure function of the values its free heads resolve to (the build mutates none of
  // them while rendering), so an identical resolution at the same depth reuses the earlier output.
  // The memo is a trie of Maps keyed by the resolved values themselves (objects by identity,
  // primitives by value), which avoids building and hashing a string key per call.
  const rootKey = `${name}@${depth}`;
  let node = ctx.memo.get(rootKey);
  if (node !== undefined) {
    for (let hi = 0; hi < fh.length && node !== undefined; hi++) node = node.get(lookupHead(scope, fh[hi]));
    if (node !== undefined) {
      const hit = node.get(MEMO_LEAF);
      if (hit !== undefined) {
        out.push(hit);
        return;
      }
    }
  }
  const buf = [];
  renderEntry(entry, scope, ctx, depth + 1, buf);
  const str = buf.join('');
  node = ctx.memo.get(rootKey);
  if (node === undefined) {
    node = new Map();
    ctx.memo.set(rootKey, node);
  }
  for (let hi = 0; hi < fh.length; hi++) {
    const v = lookupHead(scope, fh[hi]);
    let next = node.get(v);
    if (next === undefined) {
      next = new Map();
      node.set(v, next);
    }
    node = next;
  }
  node.set(MEMO_LEAF, str);
  out.push(str);
}

/** `nodes` rendered in `scope` into the shared `out` array of chunks. */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (let idx = 0; idx < nodes.length; idx++) {
    const n = nodes[idx];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(esc(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        for (let k = 0; k < len; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === len - 1, length: len } };
          renderNodes(n.body, { vars, parent: scope }, ctx, depth, out);
        }
        break;
      }
      case 'include':
        renderInclude(n.name, scope, ctx, depth, out);
        break;
    }
  }
}

// ---------------------------------------------------------------- template codegen

/**
 * A template entry rendered: its compiled function when it has one, compiled lazily on first use; a
 * template whose generated source does not compile falls back to the node interpreter for good.
 */
function renderEntry(entry, scope, ctx, depth, out) {
  let fn = entry.fn;
  if (fn === null) {
    try {
      fn = entry.fn = compileTemplate(entry.nodes);
    } catch {
      fn = entry.fn = false;
    }
  }
  if (fn === false) renderNodes(entry.nodes, scope, ctx, depth, out);
  else fn(scope, ctx, depth, out);
}

const CODEGEN_HELPERS = { esc, textOf, truthy, lookup, renderInclude, hasOwn };

/**
 * `nodes` compiled into a bespoke render function. Names bound by an enclosing for in the same template
 * become JavaScript locals (v$<name>); every other head resolves through the dynamic scope chain, exactly
 * as the interpreter's lookup does, and an include materialises the locals it must hand over into a scope
 * object. The generated statements mirror renderNodes case by case, including the lookup tail rule (own
 * properties of objects only) and the for-vars collision rule (a variable named "loop" is the loop info).
 */
function compileTemplate(nodes) {
  const paths = [];
  const chunks = [];
  const bound = new Map();
  const isBound = (n) => bound.has(n);
  const bind = (n) => bound.set(n, (bound.get(n) ?? 0) + 1);
  const unbind = (n) => {
    const c = bound.get(n) - 1;
    if (c === 0) bound.delete(n);
    else bound.set(n, c);
  };

  // Statements computing the value of path `p` into t$.
  const emitValue = (p) => {
    if (!isBound(p[0])) {
      paths.push(p);
      chunks.push(`t$ = lookup(scope, P[${paths.length - 1}]);`);
      return;
    }
    chunks.push(`t$ = v$${p[0]};`);
    for (let k = 1; k < p.length; k++)
      chunks.push(
        `t$ = t$ !== null && typeof t$ === 'object' && hasOwn(t$, ${JSON.stringify(p[k])}) ? t$[${JSON.stringify(p[k])}] : undefined;`,
      );
  };

  const emitNodes = (ns) => {
    for (const n of ns) {
      switch (n.kind) {
        case 'text':
          chunks.push(`out.push(${JSON.stringify(n.text)});`);
          break;
        case 'var':
          emitValue(n.path);
          chunks.push('out.push(esc(textOf(t$)));');
          break;
        case 'raw':
          emitValue(n.path);
          chunks.push('out.push(textOf(t$));');
          break;
        case 'if': {
          emitValue(n.path);
          chunks.push(`if (truthy(t$) !== ${n.not}) {`);
          emitNodes(n.then);
          if (n.else !== null) {
            chunks.push('} else {');
            emitNodes(n.else);
          }
          chunks.push('}');
          break;
        }
        case 'for': {
          emitValue(n.path);
          chunks.push('if (Array.isArray(t$)) {');
          chunks.push('const xs$ = t$;');
          chunks.push('const len$ = xs$.length;');
          chunks.push('for (let k$ = 0; k$ < len$; k$++) {');
          if (n.name !== 'loop') chunks.push(`let v$${n.name} = xs$[k$];`);
          chunks.push('let v$loop = { index: k$ + 1, first: k$ === 0, last: k$ === len$ - 1, length: len$ };');
          bind(n.name);
          bind('loop');
          emitNodes(n.body);
          unbind('loop');
          unbind(n.name);
          chunks.push('}');
          chunks.push('}');
          break;
        }
        case 'include': {
          if (bound.size === 0) {
            chunks.push(`renderInclude(${JSON.stringify(n.name)}, scope, ctx, depth, out);`);
          } else {
            const parts = [];
            for (const name of bound.keys()) parts.push(`${JSON.stringify(name)}: v$${name}`);
            chunks.push(
              `renderInclude(${JSON.stringify(n.name)}, { vars: { ${parts.join(', ')} }, parent: scope }, ctx, depth, out);`,
            );
          }
          break;
        }
      }
    }
  };
  emitNodes(nodes);
  const body = `const { esc, textOf, truthy, lookup, renderInclude, hasOwn } = H;\nreturn function (scope, ctx, depth, out) {\nlet t$;\n${chunks.join('\n')}\n};`;
  return new Function('H', 'P', body)(CODEGEN_HELPERS, paths);
}

// ---------------------------------------------------------------- the build

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** Whether `t` opens with a URI scheme (a letter, then letters, digits, "+", "-" or ".", then ":"). */
function hasScheme(t) {
  if (t.length < 2) return false;
  let c = t.charCodeAt(0);
  if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) return false;
  for (let i = 1; i < t.length; i++) {
    c = t.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

/** One site's output tree: path -> text, exactly makefun-site 1.0.0's for the same input. */
function build(input) {
  // Per-build memo tables (a case is answered alone; nothing is kept from one case to the next).
  const slugCache = new Map();
  const slugify = (t) => {
    const hit = slugCache.get(t);
    if (hit !== undefined) return hit;
    const v = slugifyRaw(t);
    slugCache.set(t, v);
    return v;
  };
  const dateCache = new Map();
  const longDate = (d) => {
    const hit = dateCache.get(d);
    if (hit !== undefined) return hit;
    const v = longDateRaw(d);
    dateCache.set(d, v);
    return v;
  };

  // Templates, parsed in code-unit order of their names; one that does not parse is reported and left out.
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, { nodes: parseTemplate(name, input.templates[name]), fn: null });
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // Free-head analysis for include memoisation: the head names a template reads from its scope chain. A name
  // bound by an enclosing for in the same template is not free; everything an included template reads is,
  // because it resolves through the includer's scope. Templates in an include cycle are volatile (null).
  const freeHeads = new Map();
  {
    const state = new Map();
    const headsOf = (name) => {
      const st = state.get(name);
      if (st === 2) return freeHeads.get(name);
      if (st === 1) return null;
      state.set(name, 1);
      const heads = new Set();
      let volatile = false;
      const walk = (ns, bound) => {
        for (const nd of ns) {
          if (nd.kind === 'var' || nd.kind === 'raw') {
            if (!bound.has(nd.path[0])) heads.add(nd.path[0]);
          } else if (nd.kind === 'if') {
            if (!bound.has(nd.path[0])) heads.add(nd.path[0]);
            walk(nd.then, bound);
            if (nd.else !== null) walk(nd.else, bound);
          } else if (nd.kind === 'for') {
            if (!bound.has(nd.path[0])) heads.add(nd.path[0]);
            const inner = new Set(bound);
            inner.add(nd.name);
            inner.add('loop');
            walk(nd.body, inner);
          } else if (nd.kind === 'include') {
            if (!templates.has(nd.name)) continue;
            const sub = headsOf(nd.name);
            if (sub === null) volatile = true;
            else for (const h of sub) heads.add(h);
          }
        }
      };
      walk(templates.get(name).nodes, new Set());
      state.set(name, 2);
      const res = volatile ? null : [...heads];
      freeHeads.set(name, res);
      return res;
    };
    for (const name of templates.keys()) headsOf(name);
  }

  // 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static.
  const sources = [];
  const statics = [];
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md'))
      sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const resolveCache = new Map();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const srcPath = s.path;
    const linkCache = new Map();
    const link = (target) => {
      const hit = linkCache.get(target);
      if (hit !== undefined) return hit;
      let href = target;
      let isBroken = false;
      if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) href = target;
      else {
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        let path = null;
        if (rel !== '') {
          const rkey = `${dir}\n${rel}`;
          path = resolveCache.get(rkey);
          if (path === undefined) {
            path = resolvePath(dir, rel);
            resolveCache.set(rkey, path);
          }
        }
        if (path !== null) {
          const page = bySource.get(path);
          if (page !== undefined) href = `${page.url}${frag}`;
          else if (staticPaths.has(path)) href = `${base}/${path}${frag}`;
          else isBroken = true;
        } else isBroken = true;
      }
      if (isBroken) broken.add(`broken-link ${srcPath} -> ${target}`);
      linkCache.set(target, href);
      return href;
    };
    const md = renderMarkdown(s.body, link, slugify);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept)
    if (!s.post)
      s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const linkOf = (s) =>
    s === null
      ? null
      : {
          title: s.data.title,
          url: s.url,
          date: s.data.date ?? '',
          date_long: s.data.date === undefined ? '' : longDate(s.data.date),
        };
  const linkCache2 = new Map();
  const linkOfCached = (s) => {
    if (s === null) return null;
    let v = linkCache2.get(s);
    if (v === undefined) {
      v = linkOf(s);
      linkCache2.set(s, v);
    }
    return v;
  };
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const pageOf = (s) => ({
    ...(cards.get(s) ?? cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: linkOfCached(s.newer ?? null),
    older: linkOfCached(s.older ?? null),
    is_post: s.post,
  });
  const tagOf = (t) => ({
    name: t.name,
    slug: t.slug,
    url: t.url,
    count: t.posts.length,
    posts: t.posts.map((p) => cards.get(p)),
  });
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates, freeHeads, memo: new Map() };
  const output = {};
  // One root scope per render kind, its varying slots rewritten per render: the renders are
  // sequential and never nest, and a stable vars shape keeps every lookup on one hidden class.
  const scopePage = { vars: { site, tags: allTags, recent, page: null }, parent: null };
  const scopeIndex = { vars: { site, tags: allTags, recent, posts: null, pager: null }, parent: null };
  const scopeTag = { vars: { site, tags: allTags, recent, tag: null }, parent: null };
  const scopePlain = { vars: { site, tags: allTags, recent }, parent: null };
  const render = (name, vars) => {
    const entry = templates.get(name);
    if (entry === undefined) return null;
    let scope;
    if ('page' in vars) {
      scope = scopePage;
      scope.vars.page = vars.page;
    } else if ('posts' in vars) {
      scope = scopeIndex;
      scope.vars.posts = vars.posts;
      scope.vars.pager = vars.pager;
    } else if ('tag' in vars) {
      scope = scopeTag;
      scope.vars.tag = vars.tag;
    } else scope = scopePlain;
    const out = [];
    renderEntry(entry, scope, ctx, 0, out);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: {
        number: k,
        total: pages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}

/** makefun-site 1.0.0's answer for one case's input, faster. */
export function run(input) {
  return build(input);
}
