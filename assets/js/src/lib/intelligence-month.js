/* Calendar-month scope in the reporting desk's timezone. Future days have no
 * calls and must not be warmed into the CDR cache. */
const intelligenceMonthRange = (month, today) => {
    if (!/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(month) || !/^\d{4}-\d{2}-\d{2}$/.test(today) || month > today.slice(0, 7)) return null;
    const [year, number] = month.split('-').map(Number);
    const last = new Date(Date.UTC(year, number, 0)).getUTCDate();
    return { start: month + '-01', end: month === today.slice(0, 7) ? today : month + '-' + String(last).padStart(2, '0') };
};
export { intelligenceMonthRange };
