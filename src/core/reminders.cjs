// Persist due occurrences before dispatch so polling/resume never emits duplicates.
function collectDue(store, now = new Date()) {
  const pending = store.state.reminders.filter(r => r.enabled && !r.completed && new Date(r.dueAt) <= now);
  if (!pending.length) return [];
  return store.update(s => {
    const fired = [];
    for (const reminder of s.reminders) {
      if (!pending.some(p => p.id === reminder.id)) continue;
      fired.push({ ...reminder, occurrenceAt: reminder.dueAt });
      reminder.lastFiredAt = now.toISOString();
      reminder.unread = true;
      if (reminder.repeat === 'none') { reminder.completed = true; reminder.enabled = false; }
      else {
        // setDate preserves local wall-clock time across daylight-saving changes.
        const next = new Date(reminder.dueAt), days = reminder.repeat === 'daily' ? 1 : 7;
        while (next <= now) next.setDate(next.getDate() + days);
        reminder.dueAt = next.toISOString();
      }
    }
    return fired;
  });
}
module.exports = { collectDue };
