/* Create an actual XLSX workbook locally, without sending call text elsewhere.
 * All data cells are inline strings, never formulas (even if text starts with =).
 */
import { strToU8, zipSync } from 'fflate';
import { formatCallDate, formatCallTime } from './time.js';

const xmlText = value => String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/gu, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const colName = index => {
    let result = '';
    for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + (n - 1) % 26) + result;
    return result;
};

const sheetXml = (rows, widths, autoFilter) => {
    if (rows.length > 1048576) throw new Error('This export exceeds Excel’s row limit. Narrow the filters and try again.');
    const body = rows.map((row, index) => '<row r="' + (index + 1) + '">' + row.map((value, col) => {
        const text = String(value ?? '');
        if (text.length > 32767) throw new Error('A cell exceeds Excel’s 32,767-character limit. Narrow the report or review the call data.');
        return '<c r="' + colName(col) + (index + 1) + '" t="inlineStr"><is><t xml:space="preserve">' + xmlText(text) + '</t></is></c>';
    }).join('') + '</row>').join('');
    const columns = widths.map((width, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + width + '" customWidth="1"/>').join('');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
        '<cols>' + columns + '</cols><sheetData>' + body + '</sheetData>' +
        (autoFilter && rows.length ? '<autoFilter ref="A1:' + colName(rows[0].length - 1) + rows.length + '"/>' : '') + '</worksheet>';
};

const intelligenceWorkbook = (rows, metadata) => {
    const header = ['Date', 'Time', 'PBX reference type', 'PBX reference', 'Topics', 'Summary', 'Match result', 'Matched keywords', 'Matching excerpts', 'Lookup status', 'Lookup detail'];
    const calls = [header, ...rows.map(row => [
        formatCallDate(row.startedAt) || row.startedAt || '', formatCallTime(row.startedAt), row.callIdField || '', row.callId || '',
        (row.topics || []).join('; '), row.summary || '', row.matches?.length ? 'Matched' : (row.status === 'finished' ? 'No match' : 'Not fully checked'),
        (row.matches || []).map(m => m.keyword).join('; '),
        (row.matches || []).map(m => m.keyword + ' (' + m.source + '): ' + m.excerpt).join('\n'), row.status || '', row.detail || ''
    ])];
    const info = [['Report information', 'Value'], ...metadata];
    const files = {
        '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
        '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        'xl/workbook.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Calls" sheetId="1" r:id="rId1"/><sheet name="Report information" sheetId="2" r:id="rId2"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>',
        'xl/worksheets/sheet1.xml': sheetXml(calls, [14, 13, 20, 32, 40, 65, 20, 30, 70, 18, 50], true),
        'xl/worksheets/sheet2.xml': sheetXml(info, [30, 80], false)
    };
    return zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])), { level: 1 });
};

const downloadIntelligenceWorkbook = (rows, metadata, month, partial = false) => {
    const blob = new Blob([intelligenceWorkbook(rows, metadata)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'topics-and-summaries-' + month + (partial ? '-partial' : '') + '.xlsx';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
};

export { downloadIntelligenceWorkbook, intelligenceWorkbook };
