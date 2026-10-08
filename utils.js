// Pure helpers (no Firebase, no DOM) so they can be unit-tested in Node.

export const TZ = "Asia/Manila"; // UTC+8, no daylight saving
const dateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });

/** "YYYY-MM-DD" in Philippine time (fixes the UTC date bug). */
export const dateKey = (d = new Date()) => dateFmt.format(d);
export const formatTime = (d) => d ? d.toLocaleTimeString("en-PH", { timeZone: TZ, hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
export const formatDate = (key) => new Date(key + "T00:00:00+08:00").toLocaleDateString("en-PH", { timeZone: TZ, year: "numeric", month: "short", day: "numeric" });

export function escapeHTML(v) {
  return String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
}

export const isValidLRN = (v) => /^\d{12}$/.test(v);

// ---- QR payloads: "SLNHS:" + 192-bit random token. The LRN is NOT in the QR. ----
export const QR_PREFIX = "SLNHS:";
export function makeToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); // 32 chars
}
export const makeQRData = (token) => QR_PREFIX + token;
export function parseQR(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s.startsWith(QR_PREFIX)) return null;
  const t = s.slice(QR_PREFIX.length);
  return /^[A-Za-z0-9_-]{32}$/.test(t) ? t : null;
}

/** CSV cell with quote escaping + spreadsheet-formula neutralising. */
export function csvCell(v) {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}

const bySectionName = (a, b) => (a.section || "").localeCompare(b.section || "") || (a.name || "").localeCompare(b.name || "");

/**
 * Build a report.
 * students: [{studentId,name,section,status,registeredDate}]
 * records:  [{studentId,name,section,date,time}]  (one per student per day)
 * Single day  -> one row per student: present / absent / pending (today, not scanned yet)
 * Date range  -> one row per student: days present, days absent, %
 *   "School days" = dates that have at least one scan. Today is excluded from absences
 *   because the day isn't over yet.
 */
export function computeReport({ students, records, from, to, today, section }) {
  const byStudent = new Map();
  for (const r of records) {
    if (!byStudent.has(r.studentId)) byStudent.set(r.studentId, []);
    byStudent.get(r.studentId).push(r);
  }
  const known = new Map(students.map(s => [s.studentId, s]));
  const include = (s) => !section || s.section === section;

  const people = [];
  for (const s of students) {
    if (include(s) && (s.status === "Active" || byStudent.has(s.studentId))) people.push(s);
  }
  for (const [id, recs] of byStudent) {          // students deleted after they were scanned
    if (!known.has(id)) {
      const s = { studentId: id, name: recs[0].name, section: recs[0].section, status: "Removed", registeredDate: "" };
      if (include(s)) people.push(s);
    }
  }
  people.sort(bySectionName);

  const dates = [...new Set(records.map(r => r.date))].sort();

  if (from === to) {
    const rows = people
      .filter(s => byStudent.has(s.studentId) || !s.registeredDate || s.registeredDate <= from)
      .map(s => {
        const rec = (byStudent.get(s.studentId) || [])[0];
        const status = rec ? "present" : from > today ? "none" : from === today ? "pending" : "absent";
        return { studentId: s.studentId, name: s.name, section: s.section, status, time: rec ? rec.time : null };
      });
    return { mode: "day", rows, schoolDays: dates.length };
  }

  const schoolDays = dates.filter(d => d !== today);
  const rows = people.map(s => {
    const days = new Set((byStudent.get(s.studentId) || []).map(r => r.date));
    const present = days.size;
    const absent = schoolDays.filter(d => (!s.registeredDate || d >= s.registeredDate) && !days.has(d)).length;
    const total = present + absent;
    return { studentId: s.studentId, name: s.name, section: s.section, present, absent, pct: total ? Math.round(present * 100 / total) : 0 };
  });
  return { mode: "range", rows, schoolDays: dates.length };
}
