import { auth, configured } from "./firebase.js";
import {
  onAuthStateChanged, signInWithEmailAndPassword, signOut, setPersistence,
  browserSessionPersistence, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import * as api from "./api.js";
import {
  TZ, dateKey, formatTime, formatDate, escapeHTML as esc, isValidLRN, makeQRData, csvCell, computeReport
} from "./utils.js";

const $ = (id) => document.getElementById(id);

/* ============================== state ============================== */
const ROLE_LABEL = { admin: "Administrator", teacher: "Teacher" };
const ROLE_PERMISSIONS = {
  admin: ["dashboard", "admin", "students", "scanner", "reports"],
  teacher: ["dashboard", "scanner", "reports"]
};
let me = null;                       // {uid,email,name,role}
let students = [], studentMap = new Map();
let todayRecords = [], currentDate = dateKey();
let unsubs = [], todayUnsub = null, midnightTimer = null;
let lastStudentId = null;
let reportRecords = [], reportLive = false, reportSeq = 0, lastReport = null;
const photos = { reg: "", edit: "" };
let editingId = null, editDetailsLoaded = false;

const isAdmin = () => me?.role === "admin";
const canAccess = (page) => !!(me && ROLE_PERMISSIONS[me.role]?.includes(page));
const deny = (msg) => alert(msg || "You do not have permission to do that.");

function friendlyError(e) {
  const c = e?.code || "";
  if (c === "permission-denied") return "Not allowed. Your role may not permit this, or the Firestore rules need updating.";
  if (c === "unavailable" || c === "auth/network-request-failed") return "No connection to the server. Check the internet and try again.";
  if (c === "auth/email-already-in-use") return "That email already has an account.";
  if (c === "auth/weak-password") return "Password is too weak (use at least 8 characters).";
  if (c === "auth/invalid-email") return "That email address is not valid.";
  return e?.message || "Something went wrong.";
}

/* ============================== settings / customization ============================== */
const defaultEdit = {
  schoolName: "STA. LUCIA NATIONAL HIGH SCHOOL", schoolCity: "PAGADIAN CITY",
  systemTitle: "Automated Digital Attendance System",
  subtitle: "Built-in QR scanner • real-time attendance records • attendance monitoring",
  heroTitle: "SMART ATTENDANCE, ONE SCAN.",
  heroDescription: "A modern school attendance platform for student registration, QR-based attendance scanning, real-time monitoring, and organized attendance reports.",
  schoolYear: "2026-2027", principal: "", maroon: "#6f1025", gold: "#d9a441"
};
let settings = { ...defaultEdit };

function applyEdit(c) {
  $("schoolName").textContent = c.schoolName; $("schoolCity").textContent = c.schoolCity;
  $("systemSubtitle").textContent = c.subtitle;
  $("heroTitle").textContent = c.heroTitle; $("heroDescription").textContent = c.heroDescription;
  $("systemFooter").textContent = c.schoolName + " • " + c.systemTitle + " • Research Prototype";
  document.documentElement.style.setProperty("--maroon", c.maroon);
  document.documentElement.style.setProperty("--gold", c.gold);
  document.querySelectorAll(".maroon-fill").forEach(e => e.style.background = c.maroon);
  if ($("dashboard").classList.contains("active")) $("pageTitle").textContent = c.systemTitle;
}
async function loadSettings() {
  try { const s = await api.getSettings(); settings = { ...defaultEdit, ...(s || {}) }; } catch { settings = { ...defaultEdit }; }
  applyEdit(settings);
  fillFormDefaults();
}
const EDIT_FIELDS = { editSchoolName: "schoolName", editSchoolCity: "schoolCity", editSystemTitle: "systemTitle", editSubtitle: "subtitle",
  editHeroTitle: "heroTitle", editHeroDescription: "heroDescription", editSchoolYear: "schoolYear", editPrincipal: "principal",
  editMaroon: "maroon", editGold: "gold" };
function openEditor() {
  if (!isAdmin()) return deny("Only the Administrator can edit the system.");
  for (const [id, key] of Object.entries(EDIT_FIELDS)) $(id).value = settings[key] ?? "";
  $("maroonHex").textContent = settings.maroon; $("goldHex").textContent = settings.gold;
  $("editorModal").classList.add("show");
}
async function saveEditor() {
  const c = {};
  for (const [id, key] of Object.entries(EDIT_FIELDS)) c[key] = $(id).value.trim() || (key === "principal" ? "" : defaultEdit[key]);
  try { await api.saveSettings(c); settings = c; applyEdit(c); fillFormDefaults(); closeEditor(); alert("System customization saved."); }
  catch (e) { alert(friendlyError(e)); }
}
async function resetEditor() {
  if (!confirm("Reset the system text and colors to the default maroon design?")) return;
  try { await api.saveSettings(defaultEdit); settings = { ...defaultEdit }; applyEdit(settings); fillFormDefaults(); openEditor(); }
  catch (e) { alert(friendlyError(e)); }
}
function closeEditor() { $("editorModal").classList.remove("show"); }
async function toggleEditText() {
  document.body.classList.toggle("editable-active");
  const on = document.body.classList.contains("editable-active");
  document.querySelectorAll('[data-editable="true"]').forEach(el => el.contentEditable = on ? "true" : "false");
  if (!on) {
    const c = { ...settings, schoolName: $("schoolName").textContent.trim(), schoolCity: $("schoolCity").textContent.trim(),
      systemTitle: $("pageTitle").textContent.trim(), subtitle: $("systemSubtitle").textContent.trim(),
      heroTitle: $("heroTitle").textContent.trim(), heroDescription: $("heroDescription").textContent.trim() };
    try { await api.saveSettings(c); settings = c; alert("Quick text changes saved."); } catch (e) { alert(friendlyError(e)); }
  }
}

/* ============================== navigation ============================== */
const pageTitles = () => ({
  dashboard: settings.systemTitle, admin: "Admin / Teacher Control Center", students: "Student Registration & Records",
  scanner: "System QR Scanner", reports: "Attendance Reports"
});
function showPage(id) {
  if (!me) { lockUI(); return; }
  if (!canAccess(id)) { deny(me.role === "teacher" ? "Teachers can scan attendance and view reports only." : undefined); return; }
  if (id !== "scanner") stopCamera();
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active", "print-page"));
  $(id).classList.add("active");
  document.querySelectorAll(".nav button").forEach(b => b.classList.toggle("active", b.dataset.page === id));
  $("pageTitle").textContent = pageTitles()[id] || settings.systemTitle;
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (id === "reports") loadReport();
  if (id === "admin") loadUsers();
  if (id === "scanner") enterScanner();
}
const go = showPage;

function applyRoleAccess() {
  const role = me?.role;
  document.querySelectorAll("[data-access]").forEach(el => {
    el.style.display = (!role || (el.dataset.access === "admin" && role !== "admin")) ? "none" : "";
  });
  document.querySelectorAll(".admin-only-control").forEach(el => el.style.display = role === "admin" ? "" : "none");
  $("currentRole").textContent = role ? `${ROLE_LABEL[role]}${me.name ? " — " + me.name : ""}` : "Not signed in";
}

/* ============================== login / session ============================== */
function lockUI() {
  document.body.classList.add("login-locked");
  $("loginGate").style.display = "flex";
  $("loginPassword").value = "";
  applyRoleAccess();
}
function unlockUI() {
  document.body.classList.remove("login-locked");
  $("loginGate").style.display = "none";
  $("loginError").style.display = "none";
  $("loginPassword").value = "";
  applyRoleAccess();
}
function showLoginError(msg) { const e = $("loginError"); e.textContent = msg; e.style.display = "block"; }

async function loginSystem() {
  const email = $("loginUsername").value.trim(), password = $("loginPassword").value;
  $("loginError").style.display = "none";
  if (!configured) return showLoginError("Firebase is not configured yet. Fill in js/firebase-config.js (see SETUP.md).");
  if (!email || !password) return showLoginError("Enter your email and password.");
  const btn = $("loginBtn"); btn.disabled = true;
  try {
    await setPersistence(auth, browserSessionPersistence);   // signed out when the tab closes (shared school PCs)
    await signInWithEmailAndPassword(auth, email, password);
  } catch (e) {
    const bad = ["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found", "auth/invalid-login-credentials"];
    showLoginError(bad.includes(e.code) ? "Invalid email or password." : e.code === "auth/too-many-requests" ? "Too many attempts. Try again later." : friendlyError(e));
    $("loginPassword").value = ""; $("loginPassword").focus();
  } finally { btn.disabled = false; }
}
async function resetPassword() {
  const email = $("loginUsername").value.trim();
  if (!email) return showLoginError("Type your email above first, then click “Forgot password?”.");
  try { await sendPasswordResetEmail(auth, email); alert("If that email has an account, a password reset link has been sent."); }
  catch (e) { showLoginError(friendlyError(e)); }
}
async function logoutSystem() { stopCamera(); await signOut(auth); }

onAuthStateChanged(auth, async (user) => {
  if (!user) { me = null; stopListeners(); lockUI(); return; }
  try {
    const p = await api.loadProfile(user.uid);
    if (!p || !ROLE_LABEL[p.role]) { showLoginError("This account has no access to the system. Ask the Administrator."); await signOut(auth); return; }
    me = { uid: user.uid, email: user.email, name: p.name || user.email, role: p.role };
    unlockUI();
    await loadSettings();
    startListeners();
    initReportDates();
    showPage("dashboard");
  } catch (e) {
    showLoginError("Could not load your account: " + friendlyError(e));
    await signOut(auth);
  }
});

/* ============================== live data ============================== */
function onListenErr(e) { console.error(e); }
function startListeners() {
  stopListeners();
  unsubs.push(api.subscribeStudents(list => {
    students = list; studentMap = new Map(list.map(s => [s.studentId, s]));
    updateStats(); renderStudentTable(); fillSectionFilter(); if (reportIsOpen()) renderReport();
  }, onListenErr));
  subscribeToday();
  midnightTimer = setInterval(() => { if (dateKey() !== currentDate) { subscribeToday(); initReportDates(); } }, 30000);
}
function subscribeToday() {
  todayUnsub?.();
  currentDate = dateKey();
  todayUnsub = api.subscribeAttendance(currentDate, recs => {
    todayRecords = recs; updateStats(); renderRecentScans();
    if (reportLive) { reportRecords = todayRecords; if (reportIsOpen()) renderReport(); }
  }, onListenErr);
}
function stopListeners() {
  unsubs.forEach(u => u()); unsubs = []; todayUnsub?.(); todayUnsub = null; clearInterval(midnightTimer);
  students = []; studentMap = new Map(); todayRecords = []; reportRecords = []; lastStudentId = null;
}
const reportIsOpen = () => $("reports").classList.contains("active");

function updateStats() {
  const active = students.filter(s => s.status === "Active");
  const present = todayRecords.filter(r => studentMap.get(r.studentId)?.status === "Active").length;
  $("statStudents").textContent = students.length;
  $("statPresent").textContent = present;
  $("statAbsent").textContent = Math.max(0, active.length - present);
  $("teacherPresent").textContent = present;
}

/* ============================== student form ============================== */
function formFields(p, editing = false) {
  return `
    <div class="full"><label>Full Name</label><input id="${p}Name" placeholder="e.g. JUAN D. CRUZ"></div>
    <div><label>Learner's Reference Number (LRN)</label><input id="${p}StudentId" inputmode="numeric" maxlength="12" placeholder="12-digit LRN" ${editing ? "readonly" : ""}></div>
    <div><label>Grade & Section</label><input id="${p}Section" placeholder="Grade 11 - Ruby"></div>
    <div><label>Adviser / Class Adviser</label><input id="${p}Adviser" placeholder="Enter adviser name"></div>
    <div><label>Student Status</label><select id="${p}Status"><option>Active</option><option>Inactive</option></select></div>
    <div class="full"><label>Address</label><input id="${p}Address" placeholder="Enter student's address"></div>
    <div><label>Contact Number</label><input id="${p}Contact" placeholder="09XXXXXXXXX"></div>
    <div><label>School Year / Valid Until</label><input id="${p}SchoolYear" placeholder="2026-2027"></div>
    <div><label>Parent / Guardian</label><input id="${p}Guardian" placeholder="Enter parent/guardian name"></div>
    <div><label>Principal</label><input id="${p}Principal" placeholder="Enter principal name"></div>
    <div class="full"><label>Student Photo (2x2)</label>
      <div class="photo-picker">
        <div class="photo-preview" id="${p}PhotoPreview">No photo</div>
        <div>
          <input type="file" id="${p}PhotoFile" accept="image/*">
          <button type="button" class="btn lightbtn" style="margin-top:8px" onclick="clearPhoto('${p}')">Remove photo</button>
          <small class="hint">Auto-cropped to a square and compressed for the ID card.</small>
        </div>
      </div>
    </div>`;
}
const val = (id) => $(id).value.trim();
function readForm(p) {
  return { name: val(p + "Name"), studentId: val(p + "StudentId"), section: val(p + "Section"), adviser: val(p + "Adviser"),
    status: $(p + "Status").value, address: val(p + "Address"), contact: val(p + "Contact"),
    schoolYear: val(p + "SchoolYear"), guardian: val(p + "Guardian"), principal: val(p + "Principal") };
}
const coreOf = (v) => ({ studentId: v.studentId, name: v.name, section: v.section, status: v.status });
function detailsOf(v, photo) {
  const d = { address: v.address, contact: v.contact, guardian: v.guardian, adviser: v.adviser, principal: v.principal, schoolYear: v.schoolYear };
  if (photo) d.photo = photo;
  return d;
}
function validateForm(v, isNew) {
  if (!v.name || !v.section) return "Please enter the student's name and grade/section.";
  if (isNew && !isValidLRN(v.studentId)) return "The LRN must be exactly 12 digits.";
  if (v.contact && !/^[0-9+\-\s()]{7,20}$/.test(v.contact)) return "Contact number looks invalid.";
  return null;
}
function fillFormDefaults() {
  if (!$("regSchoolYear")) return;
  if (!$("regSchoolYear").value) $("regSchoolYear").value = settings.schoolYear || "";
  if (!$("regPrincipal").value) $("regPrincipal").value = settings.principal || "";
}

/* ---- photo: resize to a 300x300 JPEG (≈20–40 KB) so it fits comfortably in Firestore ---- */
async function fileToSquareJPEG(file, size = 300) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: "from-image" }); } catch { bmp = await createImageBitmap(file); }
  const s = Math.min(bmp.width, bmp.height);
  const c = document.createElement("canvas"); c.width = c.height = size;
  c.getContext("2d").drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, size, size);
  return c.toDataURL("image/jpeg", 0.82);
}
const safePhoto = (p) => (typeof p === "string" && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(p)) ? p : "";
function showPhotoPreview(p) { $(p + "PhotoPreview").innerHTML = photos[p] ? `<img src="${photos[p]}" alt="Student photo preview">` : "No photo"; }
function clearPhoto(p) { photos[p] = ""; $(p + "PhotoFile").value = ""; showPhotoPreview(p); }
function bindPhoto(p) {
  $(p + "PhotoFile").addEventListener("change", async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { photos[p] = await fileToSquareJPEG(f); showPhotoPreview(p); } catch { alert("Could not read that image. Try a JPG or PNG."); }
  });
}

/* ============================== register / ID card ============================== */
async function registerStudent() {
  if (!isAdmin()) return deny("Only the Administrator can register students.");
  const v = readForm("reg"), err = validateForm(v, true);
  if (err) return alert(err);
  const btn = $("regBtn"); btn.disabled = true;
  try {
    const details = detailsOf(v, photos.reg);
    const token = await api.registerStudent(coreOf(v), details);
    lastStudentId = v.studentId;
    renderID(coreOf(v), details, token);
    const st = $("regStatus"); st.style.display = "block";
    st.innerHTML = "<b>✓ Student registered successfully.</b> A two-sided school ID and unique QR attendance code have been generated.";
    ["regName", "regStudentId", "regAddress", "regContact", "regGuardian"].forEach(id => $(id).value = "");
    clearPhoto("reg");
  } catch (e) { alert(friendlyError(e)); }
  finally { btn.disabled = false; }
}

function renderID(s, d, token) {
  const photo = safePhoto(d.photo);
  const photoHTML = photo ? `<img src="${photo}" alt="Student photo">` : `<span>2x2<br>STUDENT<br>PHOTO</span>`;
  $("idOutput").innerHTML = `
  <div class="id-preview" id="printCard">
    <div class="school-id">
      <div class="id-top-ribbon"></div>
      <div class="id-school-head">
        <div class="dept">REPUBLIC OF THE PHILIPPINES<br>DEPARTMENT OF EDUCATION<br>REGION IX - ZAMBOANGA PENINSULA<br>DIVISION OF PAGADIAN CITY</div>
        <div class="school-title">STA. LUCIA NATIONAL HIGH SCHOOL</div>
        <div class="school-city">Pagadian City</div>
      </div>
      <div class="id-front-main">
        <div class="id-photo">${photoHTML}</div>
        <div>
          <div class="id-field-label">Name of Learner</div>
          <div class="id-field-value id-name">${esc(s.name)}</div>
          <div class="id-field-label">Learner's Reference Number</div>
          <div class="id-field-value id-lrn">${esc(s.studentId)}</div>
          <div class="id-field-label">Grade - Section</div>
          <div class="id-field-value">${esc(s.section)}</div>
        </div>
        <img class="id-logo" src="${document.querySelector('.brand img').src}" alt="School logo">
      </div>
      <div class="id-band">
        <div><div class="id-field-label">School Year</div><div class="id-field-value">${esc(d.schoolYear || settings.schoolYear || "2026-2027")}</div></div>
        <div><div class="id-field-label">Status</div><div class="id-field-value">${esc(s.status || "Active")}</div></div>
      </div>
      <div class="id-sign"><div class="id-sign-line"></div><small>${esc(d.principal || "School Principal")}<br>Principal</small></div>
    </div>

    <div class="school-id id-back">
      <div class="id-top-ribbon"></div>
      <div class="id-back-title">STUDENT IDENTIFICATION CARD</div>
      <div class="id-rule"><b>This card is non-transferable.</b> It must be worn at all times when inside school premises. If found, please return it to the school. Any alteration or erasure will make it invalid.</div>
      <div class="id-back-grid">
        <div class="id-back-item"><b>Name</b><span>${esc(s.name)}</span></div>
        <div class="id-back-item"><b>LRN</b><span>${esc(s.studentId)}</span></div>
        <div class="id-back-item full"><b>Address</b><span>${esc(d.address || "—")}</span></div>
        <div class="id-back-item"><b>Contact Number</b><span>${esc(d.contact || "—")}</span></div>
        <div class="id-back-item"><b>Valid Until</b><span>${esc(d.schoolYear || settings.schoolYear || "2026-2027")}</span></div>
        <div class="id-back-item full"><b>Parent / Guardian</b><span>${esc(d.guardian || "—")}</span></div>
        <div class="id-back-item full"><b>Adviser</b><span>${esc(d.adviser || "—")}</span></div>
      </div>
      <div class="id-contact">If found, please return to STA. LUCIA NATIONAL HIGH SCHOOL, PAGADIAN CITY.</div>
      <div class="id-back-footer">
        <div><div class="line"></div><small>STUDENT'S SIGNATURE</small></div>
        <div><div class="line"></div><small>${esc(d.principal || "PRINCIPAL")}<br>PRINCIPAL</small></div>
      </div>
    </div>
  </div>
  <div class="card id-qr-card">
    <h3>Attendance QR Code</h3>
    <div id="qrcode"></div>
    <small class="hint">Print this with the ID. The QR holds a random secret code, not the LRN.</small>
    <button class="btn lightbtn no-print" data-regen="${esc(s.studentId)}">🔄 Regenerate QR (lost / stolen ID)</button>
  </div>`;
  new QRCode($("qrcode"), { text: makeQRData(token), width: 150, height: 150, colorDark: "#000", colorLight: "#fff", correctLevel: QRCode.CorrectLevel.H });
}

async function showID(lrn) {
  const s = studentMap.get(lrn); if (!s) return;
  try {
    showPage("students");
    $("idOutput").innerHTML = "<p style='color:#64748b'>Loading ID…</p>";
    const [d, existing] = await Promise.all([api.getDetails(lrn), api.getQrToken(lrn)]);
    const token = existing || await api.regenerateQR(lrn);
    lastStudentId = lrn;
    renderID(s, d, token);
    $("idCardWrap").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) { alert(friendlyError(e)); }
}
async function regenQR(lrn) {
  const s = studentMap.get(lrn); if (!s) return;
  const ok = await confirmDialog("Regenerate QR code?", `The current QR for <b>${esc(s.name)}</b> will stop working immediately. Print the new one and give it to the student.`, "Regenerate");
  if (!ok) return;
  try { await api.regenerateQR(lrn); await showID(lrn); } catch (e) { alert(friendlyError(e)); }
}

/* Print only the chosen section (everything else is hidden by .page/.no-print print rules). */
function printSection(id) {
  document.querySelectorAll(".page").forEach(p => p.classList.remove("print-page"));
  $(id).classList.add("print-page");
  window.addEventListener("afterprint", () => $(id).classList.remove("print-page"), { once: true });
  window.print();
}
function printId() {
  if (!lastStudentId) return alert("Register a student (or open one with “ID / QR”) first.");
  printSection("students");
}

/* ============================== student records (list / edit / delete) ============================== */
const bySectionName = (a, b) => (a.section || "").localeCompare(b.section || "") || (a.name || "").localeCompare(b.name || "");
const ROW_LIMIT = 200;
function renderStudentTable() {
  const body = $("studentBody"); if (!body) return;
  const q = ($("studentSearch").value || "").trim().toLowerCase();
  const list = students.filter(s => !q || `${s.name} ${s.studentId} ${s.section}`.toLowerCase().includes(q)).sort(bySectionName);
  const shown = list.slice(0, ROW_LIMIT);
  body.innerHTML = shown.length ? shown.map(s => `<tr>
      <td><b>${esc(s.name)}</b></td><td>${esc(s.studentId)}</td><td>${esc(s.section)}</td>
      <td><span class="pill ${s.status === "Active" ? "present" : "pending"}">${esc(s.status)}</span></td>
      <td class="row-actions">
        <button class="btn lightbtn" data-act="id" data-id="${esc(s.studentId)}">🪪 ID / QR</button>
        <button class="btn lightbtn" data-act="edit" data-id="${esc(s.studentId)}">✏️ Edit</button>
        <button class="btn red" data-act="delete" data-id="${esc(s.studentId)}">🗑 Delete</button>
      </td></tr>`).join("")
    : `<tr><td colspan="5">${students.length ? "No matching students." : "No students registered yet."}</td></tr>`;
  $("studentCount").textContent = list.length > ROW_LIMIT ? `Showing first ${ROW_LIMIT} of ${list.length} — use search to narrow down.` : `${list.length} student(s)`;
}

async function openEdit(lrn) {
  const s = studentMap.get(lrn); if (!s) return;
  editingId = lrn; editDetailsLoaded = false;
  $("editFields").innerHTML = formFields("edit", true); bindPhoto("edit");
  $("editName").value = s.name; $("editStudentId").value = lrn; $("editSection").value = s.section; $("editStatus").value = s.status;
  photos.edit = ""; showPhotoPreview("edit");
  $("studentSaveBtn").disabled = true; $("studentModal").classList.add("show");
  try {
    const d = await api.getDetails(lrn);
    if (editingId !== lrn) return;
    $("editAdviser").value = d.adviser || ""; $("editAddress").value = d.address || ""; $("editContact").value = d.contact || "";
    $("editSchoolYear").value = d.schoolYear || ""; $("editGuardian").value = d.guardian || ""; $("editPrincipal").value = d.principal || "";
    photos.edit = safePhoto(d.photo); showPhotoPreview("edit");
    editDetailsLoaded = true; $("studentSaveBtn").disabled = false;
  } catch (e) { alert(friendlyError(e)); closeStudentModal(); }
}
async function saveStudentEdit() {
  if (!isAdmin() || !editingId || !editDetailsLoaded) return;
  const v = readForm("edit"), err = validateForm(v, false);
  if (err) return alert(err);
  $("studentSaveBtn").disabled = true;
  try { await api.updateStudent(editingId, coreOf(v), detailsOf(v, photos.edit)); closeStudentModal(); }
  catch (e) { alert(friendlyError(e)); $("studentSaveBtn").disabled = false; }
}
function closeStudentModal() { $("studentModal").classList.remove("show"); editingId = null; }

async function deleteStudent(lrn) {
  if (!isAdmin()) return deny();
  const s = studentMap.get(lrn); if (!s) return;
  const ok = await confirmDialog("Delete student?",
    `<b>${esc(s.name)}</b> (LRN ${esc(lrn)}) will be removed together with their details, photo and QR code. <br><br>Past attendance records are kept for reports. If the student only transferred or dropped, set their status to <b>Inactive</b> instead.`,
    "Delete permanently", true);
  if (!ok) return;
  try {
    await api.deleteStudent(lrn);
    if (lastStudentId === lrn) { lastStudentId = null; $("idOutput").innerHTML = '<p style="color:#64748b">Register a student above to generate the digital ID and QR code.</p>'; }
  } catch (e) { alert(friendlyError(e)); }
}

/* ============================== confirm dialog (reuses #modal) ============================== */
let pendingConfirm = null;
function confirmDialog(title, html, okLabel = "Confirm", danger = false) {
  return new Promise(resolve => {
    pendingConfirm?.(false);
    pendingConfirm = resolve;
    $("modalTitle").textContent = title;
    $("modalBody").innerHTML = `<div style="line-height:1.55">${html}</div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
        <button class="btn lightbtn" style="margin:0" id="cdNo">Cancel</button>
        <button class="btn ${danger ? "red" : "primary"}" style="margin:0" id="cdYes">${esc(okLabel)}</button></div>`;
    $("modal").classList.add("show");
    $("cdNo").onclick = () => closeModal(false);
    $("cdYes").onclick = () => closeModal(true);
  });
}
function closeModal(result = false) {
  $("modal").classList.remove("show");
  const r = pendingConfirm; pendingConfirm = null; r?.(result === true);
}

/* ============================== scanner ============================== */
let qr = null, camOn = false, facing = "environment", scanBusy = false, lastText = "", lastAt = 0, audioCtx = null;

function beep(ok) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = ok ? 880 : 220; g.gain.value = 0.08; o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + (ok ? 0.12 : 0.3));
  } catch { /* sound is optional */ }
}
function setCamUI() {
  const cam = scanMode === "camera";
  $("camActions").style.display = cam ? "" : "none";
  $("camStartBtn").style.display = camOn ? "none" : "";
  $("camStopBtn").style.display = camOn ? "" : "none";
  $("camFlipBtn").style.display = camOn ? "" : "none";
  $("scannerIdle").style.display = camOn ? "none" : "";
  $("scannerIdleTitle").textContent = cam ? "CAMERA OFF" : "READY TO SCAN";
  $("scannerIdleText").innerHTML = cam ? "Press <b>Start Camera</b> and show the student's QR code." : "Scan the student's QR code with the USB scanner.";
  $("scannerStatus").textContent = camOn ? "CAMERA ON" : cam ? "CAMERA MODE" : "USB MODE";
  $("modeUsb").classList.toggle("active", !cam);
  $("modeCam").classList.toggle("active", cam);
  $("useCameraLink").style.display = cam ? "none" : "";
}
/* ---- scan mode: USB scanner (default) or device camera; remembered per device ---- */
const MODE_KEY = "slnhs_scan_mode";
const cameraSupported = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
let scanMode = "usb", usbFailStreak = 0;
try { if (localStorage.getItem(MODE_KEY) === "camera") scanMode = "camera"; } catch { /* storage unavailable */ }
const scannerOpen = () => $("scanner").classList.contains("active");
const modalOpen = () => !!document.querySelector(".modal.show");
function showScanHint(html) { const el = $("scanHint"); el.innerHTML = html; el.style.display = html ? "" : "none"; }
function focusUsb() { if (scanMode === "usb" && scannerOpen() && !modalOpen()) $("manualScan").focus(); }

async function setScanMode(mode) {
  if (mode === "camera" && !cameraSupported()) {
    showScanHint("<b>This device or browser can't use a camera here.</b> The camera needs a browser with camera access and an https:// (or localhost) page.");
    return;
  }
  scanMode = mode; usbFailStreak = 0; showScanHint("");
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* optional */ }
  if (mode === "camera") { setCamUI(); await startCamera(); }
  else { await stopCamera(); setCamUI(); focusUsb(); }
}
/** Called when the scanner page opens: apply the saved mode. */
async function enterScanner() {
  showScanHint("");
  if (scanMode === "camera" && !cameraSupported()) scanMode = "usb";
  setCamUI();
  if (scanMode === "camera") await startCamera(); else setTimeout(focusUsb, 50);
}

async function startCamera() {
  if (!me) return;
  if (!window.Html5Qrcode) return alert("The camera scanner library did not load. Check the internet connection and reload.");
  if (camOn) return;
  try {
    qr = qr || new Html5Qrcode("qrReader");
    await qr.start({ facingMode: facing },
      { fps: 10, qrbox: (w, h) => { const s = Math.floor(Math.min(w, h) * 0.7); return { width: s, height: s }; } },
      (t) => onScanText(t, "camera"), () => {});
    camOn = true; setCamUI();
  } catch (e) {
    camOn = false; setCamUI();
    const denied = /permission|denied|notallowed/i.test(String(e?.name || e?.message || e));
    showScanHint(`<b>Could not start the camera.</b> ${denied ? "Allow camera permission for this site in the browser, then press Start Camera." : "Make sure no other app is using it, and that this page is on https:// or localhost."} <button type="button" class="link-btn" onclick="setScanMode('usb')">Use the USB scanner instead</button>`);
  }
}
async function stopCamera() {
  if (qr && camOn) { try { await qr.stop(); } catch { /* already stopped */ } }
  camOn = false; if ($("camStartBtn")) setCamUI();
}
async function flipCamera() { facing = facing === "environment" ? "user" : "environment"; await stopCamera(); await startCamera(); }

async function onScanText(text, source = "usb") {
  const now = Date.now();
  if (scanBusy || (text === lastText && now - lastAt < 4000)) return;   // ignore repeats while the QR stays in view
  scanBusy = true; lastText = text; lastAt = now;
  try { await processScan(text, source); } finally { scanBusy = false; }
}

const resultBox = (cls, html) => `<div class="notice ${cls}" ${cls === "error" ? 'style="border-left-color:#dc2626;background:#fff0f0"' : ""}>${html}</div>`;
async function processScan(raw, source = "usb") {
  if (!me) return;
  raw = (raw || "").trim();
  if (!raw) return alert("Scan or paste a QR code value first.");
  const box = $("scanResult");
  box.innerHTML = resultBox("", "Checking…");
  let r;
  try { r = await api.recordAttendance(raw); } catch (e) { r = { ok: false, reason: "error", message: friendlyError(e) }; }
  if (source === "usb") {
    // Several rejects in a row from the USB scanner usually mean a scanner/keyboard problem, not a bad card.
    usbFailStreak = (!r.ok && r.reason === "invalid") ? usbFailStreak + 1 : 0;
    if (usbFailStreak >= 3) {
      showScanHint(`<b>The USB scanner's scans keep being rejected.</b> Check that Caps Lock is off and the scanner sends Enter after each scan, or <button type="button" class="link-btn" onclick="setScanMode('camera')">switch to the device camera</button>.`);
    } else if (usbFailStreak === 0) showScanHint("");
  }
  if (r.ok) {
    beep(true);
    box.innerHTML = resultBox("success", `<b>✓ Valid QR.</b><br><b>${esc(r.student.name)}</b> (${esc(r.student.section)}) is Present at <b>${esc(formatTime(r.time))}</b>.<br>Attendance has been recorded successfully.`);
  } else if (r.reason === "duplicate") {
    beep(false);
    box.innerHTML = resultBox("warning", `<b>Already recorded today.</b><br>${esc(r.student.name)} was already marked Present at ${esc(formatTime(r.time))}.`);
  } else if (r.reason === "inactive") {
    beep(false);
    box.innerHTML = resultBox("warning", `<b>Student is Inactive.</b><br>${esc(r.student.name)} is not an active student, so no attendance was recorded.`);
  } else if (r.reason === "invalid") {
    beep(false);
    box.innerHTML = resultBox("error", "<b>✕ Scan rejected.</b><br>The QR code is invalid or the student is not registered. Student must scan again.");
  } else {
    beep(false);
    box.innerHTML = resultBox("error", `<b>✕ Not recorded.</b><br>${esc(r.message || "Unexpected error.")} Please scan again.`);
  }
}
function renderRecentScans() {
  const el = $("recentScans"); if (!el) return;
  const list = [...todayRecords].sort((a, b) => (b.time?.getTime() || 0) - (a.time?.getTime() || 0)).slice(0, 10);
  el.innerHTML = list.length
    ? list.map(r => `<li><span>${esc(formatTime(r.time))}</span> <b>${esc(r.name)}</b> <small>${esc(r.section)}</small></li>`).join("")
    : "<li class='empty'>No scans yet today.</li>";
}

/* ============================== reports ============================== */
function initReportDates() { $("repFrom").value = currentDate; $("repTo").value = currentDate; }
function setPreset(kind) {
  const d = new Date(currentDate + "T00:00:00Z");
  let from = currentDate;
  if (kind === "week") { d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); from = d.toISOString().slice(0, 10); }   // Monday
  if (kind === "month") from = currentDate.slice(0, 8) + "01";
  $("repFrom").value = from; $("repTo").value = currentDate; loadReport();
}
function fillSectionFilter() {
  const sel = $("repSection"); if (!sel) return;
  const keep = sel.value;
  const sections = [...new Set(students.map(s => s.section))].sort();
  sel.innerHTML = '<option value="">All sections</option>' + sections.map(s => `<option>${esc(s)}</option>`).join("");
  sel.value = sections.includes(keep) ? keep : "";
}
async function loadReport() {
  const from = $("repFrom").value || currentDate, to = $("repTo").value || from;
  if (from > to) return alert("The “From” date must be on or before the “To” date.");
  const seq = ++reportSeq;
  if (from === to && from === currentDate) { reportLive = true; reportRecords = todayRecords; renderReport(); return; }
  reportLive = false;
  $("reportBody").innerHTML = '<tr><td colspan="6">Loading…</td></tr>';
  try {
    const recs = await api.getAttendanceRange(from, to);
    if (seq !== reportSeq) return;
    reportRecords = recs; renderReport();
  } catch (e) { $("reportBody").innerHTML = `<tr><td colspan="6">${esc(friendlyError(e))}</td></tr>`; }
}
function renderReport() {
  const from = $("repFrom").value || currentDate, to = $("repTo").value || from;
  const section = $("repSection").value;
  const rep = computeReport({ students, records: reportRecords, from, to, today: currentDate, section });
  lastReport = { ...rep, from, to, section };
  const period = from === to ? formatDate(from) : `${formatDate(from)} – ${formatDate(to)}`;
  $("repPrintTitle").textContent = `${settings.schoolName} — Attendance Report: ${period}${section ? " • " + section : ""}`;
  const pill = { present: ["present", "Present"], absent: ["absent", "Absent"], pending: ["pending", "Not Yet Scanned"], none: ["pending", "—"] };

  if (rep.mode === "day") {
    const present = rep.rows.filter(r => r.status === "present").length;
    const rest = rep.rows.length - present;
    $("reportSummary").textContent = `${present} present • ${rest} ${from === currentDate ? "not yet scanned" : "absent"} • ${rep.rows.length} students`;
    $("reportHead").innerHTML = "<tr><th>Student</th><th>LRN</th><th>Grade/Section</th><th>Status</th><th>Time</th></tr>";
    $("reportBody").innerHTML = rep.rows.length ? rep.rows.map(r => `<tr><td><b>${esc(r.name)}</b></td><td>${esc(r.studentId)}</td><td>${esc(r.section)}</td>
      <td><span class="pill ${pill[r.status][0]}">${pill[r.status][1]}</span></td><td>${esc(formatTime(r.time))}</td></tr>`).join("")
      : '<tr><td colspan="5">No students to show.</td></tr>';
  } else {
    $("reportSummary").textContent = `${rep.schoolDays} school day(s) with scans in this period (days with no scans at all are not counted; today is not counted as absent)`;
    $("reportHead").innerHTML = "<tr><th>Student</th><th>LRN</th><th>Grade/Section</th><th>Days Present</th><th>Days Absent</th><th>Attendance %</th></tr>";
    $("reportBody").innerHTML = rep.rows.length ? rep.rows.map(r => `<tr><td><b>${esc(r.name)}</b></td><td>${esc(r.studentId)}</td><td>${esc(r.section)}</td>
      <td>${r.present}</td><td>${r.absent}</td><td>${r.pct}%</td></tr>`).join("")
      : '<tr><td colspan="6">No students to show.</td></tr>';
  }
}
const printReport = () => printSection("reports");
function downloadCSV() {
  if (!lastReport) return;
  const r = lastReport;
  const rows = r.mode === "day"
    ? [["Student", "LRN", "Grade/Section", "Status", "Time"], ...r.rows.map(x => [x.name, x.studentId, x.section, ({ present: "Present", absent: "Absent", pending: "Not Yet Scanned", none: "" })[x.status], x.time ? formatTime(x.time) : ""])]
    : [["Student", "LRN", "Grade/Section", "Days Present", "Days Absent", "Attendance %"], ...r.rows.map(x => [x.name, x.studentId, x.section, x.present, x.absent, x.pct])];
  const csv = rows.map(row => row.map(csvCell).join(",")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" }));
  a.download = `SLNHS_Attendance_${r.from}${r.from === r.to ? "" : "_to_" + r.to}.csv`;
  a.click(); URL.revokeObjectURL(a.href);
}

/* ============================== staff accounts (admin) ============================== */
async function loadUsers() {
  if (!isAdmin()) return;
  const body = $("usersBody");
  try {
    const list = await api.listUsers();
    body.innerHTML = list.map(u => `<tr><td><b>${esc(u.name)}</b></td><td>${esc(u.email)}</td><td>${esc(ROLE_LABEL[u.role] || u.role)}</td>
      <td>${u.uid === me.uid ? "<small>(you)</small>" : `<button class="btn red" style="margin:0;padding:7px 10px" data-user-remove="${esc(u.uid)}" data-name="${esc(u.name)}">Remove access</button>`}</td></tr>`).join("")
      || '<tr><td colspan="4">No accounts.</td></tr>';
  } catch (e) { body.innerHTML = `<tr><td colspan="4">${esc(friendlyError(e))}</td></tr>`; }
}
async function createUser() {
  if (!isAdmin()) return deny();
  const name = val("newUserName"), email = val("newUserEmail"), password = $("newUserPassword").value, role = $("newUserRole").value;
  const msg = $("userMsg");
  if (!name || !email) return alert("Enter the staff member's name and email.");
  if (password.length < 8) return alert("The temporary password must be at least 8 characters.");
  const btn = $("newUserBtn"); btn.disabled = true;
  try {
    await api.createStaffUser({ name, email, password, role });
    msg.style.display = "block"; msg.className = "notice success"; msg.style.marginTop = "13px";
    msg.innerHTML = `<b>✓ Account created</b> for ${esc(email)} as ${esc(ROLE_LABEL[role])}. Share the temporary password privately; they can change it with “Forgot password?” on the login page.`;
    ["newUserName", "newUserEmail", "newUserPassword"].forEach(id => $(id).value = "");
    loadUsers();
  } catch (e) { alert(friendlyError(e)); }
  finally { btn.disabled = false; }
}
async function removeUser(uid, name) {
  const ok = await confirmDialog("Remove access?", `<b>${esc(name)}</b> will no longer be able to use the system. (Their login account is not deleted from Firebase Authentication, but it has no permissions.)`, "Remove access", true);
  if (!ok) return;
  try { await api.removeStaffAccess(uid); loadUsers(); } catch (e) { alert(friendlyError(e)); }
}

/* ============================== boot ============================== */
$("regFields").innerHTML = formFields("reg"); bindPhoto("reg");
$("studentBody").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-act]"); if (!b) return;
  ({ id: showID, edit: openEdit, delete: deleteStudent })[b.dataset.act]?.(b.dataset.id);
});
$("idOutput").addEventListener("click", (e) => { const b = e.target.closest("button[data-regen]"); if (b) regenQR(b.dataset.regen); });
$("usersBody").addEventListener("click", (e) => { const b = e.target.closest("button[data-user-remove]"); if (b) removeUser(b.dataset.userRemove, b.dataset.name); });
$("studentSearch").addEventListener("input", renderStudentTable);
// USB scanners type like a keyboard: if a character arrives while nothing text-like is focused, send it to the scan box.
document.addEventListener("keydown", (e) => {
  if (scanMode !== "usb" || !scannerOpen() || modalOpen() || e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
  if (e.target.matches("input,textarea,select,[contenteditable='true']")) return;
  $("manualScan").focus();
});
$("manualScan").addEventListener("blur", () => setTimeout(() => { if (document.activeElement === document.body) focusUsb(); }, 100));
$("repSection").addEventListener("change", () => renderReport());
$("manualScan").addEventListener("keydown", async (e) => {
  if (e.key !== "Enter") return;
  const v = e.target.value; e.target.value = ""; await onScanText(v, "usb"); focusUsb();     // USB scanners "type" the code + Enter
});
$("editMaroon").addEventListener("input", e => $("maroonHex").textContent = e.target.value);
$("editGold").addEventListener("input", e => $("goldHex").textContent = e.target.value);
const updateNet = () => { $("scannerNet").textContent = navigator.onLine ? "● ONLINE" : "○ OFFLINE"; };
window.addEventListener("online", updateNet); window.addEventListener("offline", updateNet); updateNet();
const updateClock = () => { $("clock").textContent = new Date().toLocaleTimeString("en-PH", { timeZone: TZ }); };
setInterval(updateClock, 1000); updateClock();
if (!configured) $("configWarning").style.display = "block";
applyEdit(defaultEdit); setCamUI(); lockUI();

// Inline onclick="" handlers in index.html need these on window (modules are not global).
Object.assign(window, {
  go, showPage, loginSystem, logoutSystem, resetPassword, registerStudent, printId, openEditor, saveEditor, resetEditor, closeEditor,
  toggleEditText, closeModal, closeStudentModal, saveStudentEdit, clearPhoto, processScan, startCamera, stopCamera, flipCamera, setScanMode,
  loadReport, setPreset, printReport, downloadCSV, createUser
});
