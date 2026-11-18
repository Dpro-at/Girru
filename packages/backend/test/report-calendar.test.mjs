import test from 'node:test';import assert from 'node:assert/strict';import{reportCalendar,nextReportOccurrence}from'../src/services/report-calendar.ts';
test('calendar validates timezone/date choices and skips missing monthly/yearly dates',()=>{
 const calendar={every:'monthly',at:'09:00',timezone:'Europe/Vienna',day:31};assert.equal(nextReportOccurrence(calendar,new Date('2026-04-01T00:00:00Z')).toISOString(),'2026-05-31T07:00:00.000Z');
 assert.equal(nextReportOccurrence({every:'yearly',at:'09:00',timezone:'Europe/Vienna',day:29,month:2},new Date('2025-03-01T00:00:00Z')).toISOString(),'2028-02-29T08:00:00.000Z');
 for(const c of [{...calendar,timezone:'Invalid/Place'},{...calendar,day:0},{every:'yearly',at:'09:00',timezone:'UTC',day:31,month:4}])assert.throws(()=>reportCalendar(c));
});
test('daily and weekly schedules use the requested timezone across daylight saving changes',()=>{
 assert.equal(nextReportOccurrence({every:'daily',at:'09:00',timezone:'Europe/Vienna'},new Date('2026-03-28T09:00:00Z')).toISOString(),'2026-03-29T07:00:00.000Z');
 assert.equal(nextReportOccurrence({every:'weekly',at:'09:00',timezone:'Europe/Vienna',weekday:1},new Date('2026-10-24T00:00:00Z')).toISOString(),'2026-10-26T08:00:00.000Z');
});
test('daylight saving gaps move forward and repeated local hours run only once',()=>{
 const c={every:'daily',at:'02:30',timezone:'Europe/Vienna'};
 assert.equal(nextReportOccurrence(c,new Date('2026-03-29T00:00:00Z')).toISOString(),'2026-03-29T01:00:00.000Z');
 assert.equal(nextReportOccurrence(c,new Date('2026-10-25T00:30:00Z')).toISOString(),'2026-10-26T01:30:00.000Z');
});
