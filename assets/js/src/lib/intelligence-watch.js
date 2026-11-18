/* Commas or line breaks separate phrases. Quoted phrases can contain commas;
 * doubled quotes inside a quoted phrase represent one literal quote. */
const parseWatchedPhrases = text => {
    const phrases = [];
    let value = '', quoted = false, closed = false;
    const finish = () => { const clean = value.trim(); if (clean) phrases.push(clean); value = ''; quoted = false; closed = false; };
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quoted) {
            if (ch === '\r' || ch === '\n') throw new Error('A quoted watched phrase must stay on one line.');
            if (ch === '"' && text[i + 1] === '"') { value += '"'; i++; }
            else if (ch === '"') { quoted = false; closed = true; }
            else value += ch;
        } else if (ch === ',' || ch === '\r' || ch === '\n') {
            finish();
        } else if (closed) {
            if (!/\s/.test(ch)) throw new Error('Add a comma or new line after a quoted watched phrase.');
        } else if (ch === '"' && !value.trim()) {
            value = ''; quoted = true;
        } else {
            value += ch;
        }
    }
    if (quoted) throw new Error('Close the quoted watched phrase before saving.');
    finish();
    return phrases;
};

const formatWatchedPhrases = phrases => phrases.map(phrase => /[,"]/.test(phrase)
    ? '"' + phrase.replace(/"/g, '""') + '"' : phrase).join('\n');

export { parseWatchedPhrases, formatWatchedPhrases };
