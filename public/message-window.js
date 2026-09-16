// Bound expensive rendered Markdown/HTML DOM, not the saved conversation.
export class MessageWindow {
  constructor(limit = 60) { this.limit = limit; this.chatId = null; this.tail = true; this.start = 0; }
  update(chatId, rows) {
    if (this.chatId !== chatId) { this.chatId = chatId; this.tail = true; this.start = 0; }
    this.rows = rows;
    this.start = this.tail ? Math.max(0, rows.length - this.limit) : Math.min(this.start, Math.max(0, rows.length - this.limit));
    this.end = Math.min(rows.length, this.start + this.limit);
    return rows.slice(this.start, this.end);
  }
  move(direction) { this.start = Math.max(0, Math.min(Math.max(0, this.rows.length - this.limit), this.start + direction * Math.floor(this.limit / 2))); this.tail = this.start + this.limit >= this.rows.length; }
  show(id) { const index = this.rows?.findIndex(row => row.id === id) ?? -1; if (index < 0) return false; this.start = Math.max(0, index - 5); this.tail = false; return true; }
  latest() { this.tail = true; }
}
