// app.js (ระบบพนักงานขาย + พิมพ์ใบเสร็จ BLE + สแกน QR Code + จัดการตาราง Cafe_Amazon_Promosion_House)
const app = document.querySelector('#app');
let html5QrCode = null;
let bluetoothDevice = null;
let bluetoothCharacteristic = null;
let currentHouseDataList = [];
let adminSession = null;
let isProcessingScan = false;
let screenWakeLock = null;
let printerStartupChecked = false;
let scanWithoutPrinter = false;
let sessionWithoutPrinter = false;

// กันหน้าจอดับขณะใช้งาน Staff เพื่อไม่ให้ Bluetooth/การสแกนถูกระบบพักการทำงาน
async function keepStaffScreenAwake() {
  if (!navigator.wakeLock || document.visibilityState !== 'visible' || screenWakeLock) return;
  try {
    screenWakeLock = await navigator.wakeLock.request('screen');
    screenWakeLock.addEventListener('release', () => {
      screenWakeLock = null;
    });
  } catch (error) {
    // บางอุปกรณ์หรือโหมดประหยัดพลังงานไม่อนุญาต Wake Lock — แอปยังใช้งานต่อได้ตามปกติ
    console.info('ไม่สามารถกันหน้าจอดับได้:', error?.message || error);
  }
}

// ระบบจะปล่อย Wake Lock เมื่อแอปอยู่เบื้องหลัง และขอใหม่เมื่อกลับเข้ามาหน้า Staff
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') keepStaffScreenAwake();
});
document.addEventListener('pointerdown', keepStaffScreenAwake, { passive: true });

// เมื่อคีย์บอร์ดมือถือเปิด ให้เลื่อนช่องที่กำลังกรอกขึ้นมาอยู่ในพื้นที่ที่มองเห็น
function keepFocusedFieldVisible() {
  const field = document.activeElement;
  if (!field?.matches('input, textarea, select')) return;
  // กล่อง User/Password เป็น fixed dialog: ให้ Chrome จัดตาม visual viewport เอง
  // เพื่อไม่ให้การเลื่อนของแอปทำให้ส่วนบนของกล่องหาย
  if (field.closest('#admin-login-form')) return;
  window.setTimeout(() => {
    // เลื่อนเท่าที่จำเป็น เพื่อให้ช่องกรอกอยู่ต่ำลงและยังไม่ถูกคีย์บอร์ดบัง
    field.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }, 180);
}

document.addEventListener('focusin', keepFocusedFieldVisible);
window.visualViewport?.addEventListener('resize', keepFocusedFieldVisible);

const removeVisibleProductCode = value => String(value ?? '')
  .replace(/สินค้า\s*รหัส\s*[-\w.]+/gi, '')
  .replace(/รหัสสินค้า\s*[:：]?\s*[-\w.]+/gi, '')
  .trim();
const esc = val => removeVisibleProductCode(val).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;' }[c]));

function maskPhoneNumber(phone) {
  if (!phone) return '-';
  const str = String(phone).trim();
  if (str.length <= 4) return 'xxxx';
  return str.slice(0, -4) + 'xxxx';
}

let appDialogTimer = null;
function showAppDialog(message, {
  title = 'แจ้งเตือน',
  autoCloseMs = 0,
  actionLabel = 'ปิด',
  cancelLabel = '',
  onAction = null,
  onCancel = null
} = {}) {
  clearTimeout(appDialogTimer);
  document.querySelector('#app-message-dialog')?.remove();
  const isInternetError = String(message).includes('เชื่อมต่อ Internet ไม่ได้');
  const messageStyle = isInternetError
    ? 'margin:0 0 18px; white-space:pre-line; line-height:1.55; color:#dc2626; font-weight:700; animation:internet-blink .85s step-end infinite;'
    : 'margin:0 0 18px; white-space:pre-line; line-height:1.55; color:#475569;';
  document.body.insertAdjacentHTML('beforeend', `
    <div id="app-message-dialog" style="position:fixed; inset:0; z-index:50000; display:grid; place-items:center; padding:20px; background:rgba(15,23,42,.55);">
      <section role="dialog" aria-modal="true" aria-labelledby="app-message-title" style="width:min(100%,360px); padding:22px; border-radius:18px; background:#fff; color:#1e293b; box-shadow:0 20px 45px rgba(0,0,0,.28); text-align:center;">
        <h2 id="app-message-title" style="margin:0 0 10px; color:#194832; font-size:1.2rem;">${esc(title)}</h2>
        <p style="${messageStyle}">${esc(message)}</p>
        <div style="display:flex; justify-content:center; gap:10px;">
          ${cancelLabel ? `<button id="btn-cancel-app-message" type="button" style="padding:10px 16px; border:0; border-radius:10px; background:#e2e8f0; color:#334155; font-weight:700;">${esc(cancelLabel)}</button>` : ''}
          <button id="btn-close-app-message" type="button" style="padding:10px 16px; border:0; border-radius:10px; background:#256b45; color:#fff; font-weight:700;">${esc(actionLabel)}</button>
        </div>
      </section><style>@keyframes internet-blink { 50% { opacity:.18; } }</style>
    </div>`);
  const dialog = document.querySelector('#app-message-dialog');
  const close = () => {
    clearTimeout(appDialogTimer);
    dialog?.remove();
  };
  document.querySelector('#btn-close-app-message').onclick = () => {
    close();
    onAction?.();
  };
  document.querySelector('#btn-cancel-app-message')?.addEventListener('click', () => {
    close();
    onCancel?.();
  });
  if (autoCloseMs > 0) appDialogTimer = setTimeout(close, autoCloseMs);
}

function showConfirmDialog(message, {
  title = 'ยืนยันรายการ',
  confirmLabel = 'ยืนยัน',
  cancelLabel = 'ยกเลิก'
} = {}) {
  return new Promise(resolve => showAppDialog(message, {
    title,
    actionLabel: confirmLabel,
    cancelLabel,
    onAction: () => resolve(true),
    onCancel: () => resolve(false)
  }));
}

function showToast(msg, title = 'แจ้งเตือน') {
  showAppDialog(msg, { title, autoCloseMs: 3000 });
}

// เปลี่ยน alert เดิมทั้งหมดให้เป็น Dialog ของแอป เพื่อไม่ให้ข้อความหายเร็วหรือถูกเบราว์เซอร์ปิดกั้น
window.alert = message => showAppDialog(message, { title: 'แจ้งเตือน' });
function releaseStaffUsageOnDisconnect() {
  const phone = adminSession?.username;
  if (phone && window.staffApi?.releaseUserUsage) {
    window.staffApi.releaseUserUsage(phone, { keepalive: true }).catch(() => {});
  }
}
window.addEventListener('offline', () => {
  showAppDialog('เชื่อมต่อ Internet ไม่ได้ กรุณาตรวจสอบหรือเชื่อมต่อ Internet แล้วลองอีกครั้ง', { title: 'Internet' });
  releaseStaffUsageOnDisconnect();
});
window.addEventListener('pagehide', releaseStaffUsageOnDisconnect);
window.addEventListener('beforeunload', releaseStaffUsageOnDisconnect);
window.addEventListener('online', async () => {
  showToast('เชื่อมต่อ Internet แล้ว');
  const phone = adminSession?.username;
  if (!phone || !window.staffApi) return;
  try {
    await window.staffApi.releaseUserUsage(phone);
    await window.staffApi.restoreUserUsage(phone);
  } catch (error) {
    console.warn('ไม่สามารถคืนสถานะ IsUse หลังเชื่อมต่อ Internet:', error);
  }
});

let installGuideShown = false;
const INSTALL_GUIDE_DISMISSED_KEY = 'staff-pwa-install-guide-dismissed';
function isInstalledPwa() {
  return Boolean(
    window.navigator.standalone ||
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: minimal-ui)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    document.referrer.startsWith('android-app://')
  );
}

function isIosDevice() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function showInstallGuide() {
  if (installGuideShown || isInstalledPwa() || localStorage.getItem(INSTALL_GUIDE_DISMISSED_KEY) === '1') return;
  const ios = isIosDevice();
  // Android/Chrome ต้องรอ beforeinstallprompt ก่อน มิฉะนั้นปุ่มติดตั้งจะกดไม่ได้
  if (!ios && !window.pwaInstallReady) return;
  installGuideShown = true;
  document.body.insertAdjacentHTML('beforeend', `
    <div id="pwa-install-guide" style="position:fixed; inset:0; z-index:30000; display:grid; place-items:center; padding:20px; background:rgba(20,40,29,.62);">
      <div style="width:min(100%,360px); padding:22px; border-radius:18px; background:#fffaf4; color:#2c241d; box-shadow:0 20px 45px rgba(0,0,0,.28); text-align:center;">
        <div style="font-size:36px;">📲</div>
        <h2 style="margin:6px 0; font-size:1.3rem; color:#194832;">ติดตั้งแอป</h2>
        <p style="margin:0 0 16px; color:#766b5e; line-height:1.55;">${ios ? 'แตะปุ่ม Share (□↑) ใน Safari แล้วเลือก “Add to Home Screen” เพื่อเพิ่มแอปลงหน้าจอหลัก' : 'ติดตั้ง D House x Café Amazon เพื่อเปิดใช้งานได้สะดวกยิ่งขึ้น'}</p>
        <div style="display:flex; justify-content:center; gap:10px;">
          <button id="btn-dismiss-install-guide" type="button" style="padding:10px 14px; border-radius:10px; background:#e8efe4; color:#194832; font-weight:700;">ภายหลัง</button>
          ${ios ? '' : '<button id="btn-install-pwa" type="button" style="padding:10px 14px; border-radius:10px; background:#256b45; color:#fff; font-weight:700;">ติดตั้งแอป</button>'}
        </div>
      </div>
    </div>`);
  const guide = document.querySelector('#pwa-install-guide');
  document.querySelector('#btn-dismiss-install-guide').onclick = () => {
    localStorage.setItem(INSTALL_GUIDE_DISMISSED_KEY, '1');
    guide.remove();
  };
  document.querySelector('#btn-install-pwa')?.addEventListener('click', async () => {
    const opened = await window.requestPwaInstall?.();
    if (!opened) {
      showToast('ยังไม่พร้อมติดตั้ง กรุณาลองรีเฟรชหน้าอีกครั้ง');
      return;
    }
    localStorage.setItem(INSTALL_GUIDE_DISMISSED_KEY, '1');
    guide.remove();
  });
}

window.addEventListener('pwa-install-available', showInstallGuide);

function showInstalledPwaNotice() {
  document.querySelector('#pwa-install-guide')?.remove();
  localStorage.setItem(INSTALL_GUIDE_DISMISSED_KEY, '1');
  document.querySelector('#pwa-installed-notice')?.remove();
  document.body.insertAdjacentHTML('beforeend', `
    <div id="pwa-installed-notice" style="position:fixed; inset:0; z-index:30001; display:grid; place-items:center; padding:20px; background:rgba(20,40,29,.62);">
      <section role="dialog" aria-modal="true" style="width:min(100%,360px); padding:22px; border-radius:18px; background:#fffaf4; color:#2c241d; box-shadow:0 20px 45px rgba(0,0,0,.28); text-align:center;">
        <div style="font-size:36px;">✅</div>
        <h2 style="margin:6px 0; font-size:1.3rem; color:#194832;">ติดตั้งแอปแล้ว</h2>
        <p style="margin:0 0 16px; color:#766b5e; line-height:1.55;">กรุณาปิดหน้าเว็บนี้ แล้วเปิดแอปจากไอคอนที่เพิ่งติดตั้งบนหน้าจอหลัก</p>
        <button id="btn-close-installed-notice" type="button" style="padding:10px 14px; border:0; border-radius:10px; background:#256b45; color:#fff; font-weight:700;">รับทราบ</button>
      </section>
    </div>`);
  document.querySelector('#btn-close-installed-notice').onclick = () => document.querySelector('#pwa-installed-notice')?.remove();
}

window.addEventListener('pwa-installed', showInstalledPwaNotice);

function createToastEl() {
  const el = document.createElement('div');
  el.id = 'toast';
  document.body.appendChild(el);
  return el;
}

// ===== ระบบเครื่องพิมพ์ Bluetooth (BLE) =====
const PRINT_WIDTH_DOTS = 384;
const PRINTER_SETTINGS_KEY = 'staff-selected-bluetooth-printer';
const PRINTER_SERVICES = [
  '000018f0-0000-1000-8000-00805f9b34fb',
  '0000ff00-0000-1000-8000-00805f9b34fb',
  '0000ffe0-0000-1000-8000-00805f9b34fb',
  '0000fff0-0000-1000-8000-00805f9b34fb',
  '0000fee7-0000-1000-8000-00805f9b34fb',
  '0000ae30-0000-1000-8000-00805f9b34fb',
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455'
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function getSavedPrinter() {
  try {
    const value = JSON.parse(localStorage.getItem(PRINTER_SETTINGS_KEY) || 'null');
    return value?.id ? value : null;
  } catch (e) {
    return null;
  }
}

function savePrinter(device) {
  localStorage.setItem(PRINTER_SETTINGS_KEY, JSON.stringify({
    id: device.id,
    name: device.name || 'Bluetooth Printer'
  }));
}

function normalizePrinterName(name) {
  return String(name || '').trim().toLowerCase();
}

function isSameSavedPrinter(device, saved) {
  if (!device || !saved) return false;
  if (device.id && device.id === saved.id) return true;
  const deviceName = normalizePrinterName(device.name);
  const savedName = normalizePrinterName(saved.name);
  return Boolean(deviceName && savedName && savedName !== 'bluetooth printer' && deviceName === savedName);
}

function clearSavedPrinter() {
  localStorage.removeItem(PRINTER_SETTINGS_KEY);
  forgetPrinter();
}

async function getConfiguredPrinterDevice() {
  const saved = getSavedPrinter();
  if (!saved) throw new Error('ยังไม่ได้ตั้งค่าเครื่องพิมพ์ กรุณาตั้งค่าจากหน้าจัดการสมาชิก');
  if (!navigator.bluetooth?.getDevices) {
    throw new Error('เบราว์เซอร์นี้ไม่สามารถตรวจสอบเครื่องพิมพ์ที่ตั้งค่าไว้ได้');
  }
  const devices = await navigator.bluetooth.getDevices();
  const device = devices.find(item => item.id === saved.id)
    || devices.find(item => isSameSavedPrinter(item, saved));
  if (!device) {
    throw new Error(`ไม่พบเครื่องพิมพ์ที่ตั้งไว้ (${saved.name}) กรุณาตั้งค่าเครื่องพิมพ์ใหม่`);
  }
  if (device.id !== saved.id) savePrinter(device);
  return device;
}

// คืนเครื่องที่เคยอนุญาตและตั้งค่าไว้ หากเบราว์เซอร์รองรับการเรียกดูอุปกรณ์เดิม
async function findConfiguredPrinterForAutoConnect(ignoreCachedDevice = false) {
  const saved = getSavedPrinter();
  if (!saved) throw new Error('ยังไม่ได้ตั้งค่าเครื่องพิมพ์ กรุณาตั้งค่าจากหน้าจัดการสมาชิก');

  // ใช้ object เดิมได้ทันทีระหว่างที่หน้าแอปยังเปิดอยู่
  if (!ignoreCachedDevice && isSameSavedPrinter(bluetoothDevice, saved)) {
    if (bluetoothDevice.id !== saved.id) savePrinter(bluetoothDevice);
    return bluetoothDevice;
  }

  // Chrome บางรุ่นรองรับ getDevices() จึงเชื่อมต่อเครื่องเดิมได้โดยไม่ต้องเปิดตัวเลือก
  if (!navigator.bluetooth?.getDevices) return null;
  const devices = await navigator.bluetooth.getDevices();
  const device = devices.find(item => item.id === saved.id)
    || devices.find(item => isSameSavedPrinter(item, saved))
    || null;
  if (device) {
    bluetoothDevice = device;
    if (device.id !== saved.id) savePrinter(device);
  }
  return device;
}

// เรียกเฉพาะจากการกดปุ่มของผู้ใช้: ใช้เมื่อเครื่องเดิมยังคืนให้ Web Bluetooth ไม่ได้
async function selectConfiguredPrinter() {
  const saved = getSavedPrinter();
  if (!saved) throw new Error('ยังไม่ได้ตั้งค่าเครื่องพิมพ์ กรุณาให้แอดมินตั้งค่าก่อน');
  const options = saved.name && saved.name !== 'Bluetooth Printer'
    ? { filters: [{ name: saved.name }], optionalServices: PRINTER_SERVICES }
    : { acceptAllDevices: true, optionalServices: PRINTER_SERVICES };
  const device = await navigator.bluetooth.requestDevice(options);
  const savedHasSpecificName = normalizePrinterName(saved.name) !== 'bluetooth printer';
  if (savedHasSpecificName && !isSameSavedPrinter(device, saved)) {
    throw new Error(`กรุณาเลือกเครื่องที่ตั้งค่าไว้ (${saved.name}) เท่านั้น`);
  }
  bluetoothDevice = device;
  bluetoothCharacteristic = null;
  // Chrome อาจเปลี่ยน device.id หลังล้างสิทธิ์หรือจับคู่ใหม่ จึงบันทึก ID ล่าสุดของเครื่องชื่อเดิม
  savePrinter(device);
  return device;
}

// พยายามใช้เครื่องเดิมก่อนเสมอ; จะเปิดตัวเลือกเฉพาะเมื่อเรียกจากปุ่มที่ผู้ใช้กดและเชื่อมต่อเดิมไม่ได้
async function ensurePrinterReadyFromUserAction() {
  try {
    return await connectBluetoothPrinter();
  } catch (firstError) {
    await selectConfiguredPrinter();
    try {
      return await connectBluetoothPrinter();
    } catch (secondError) {
      throw new Error(secondError.message || firstError.message);
    }
  }
}

function forgetPrinter() {
  try { bluetoothDevice?.gatt?.disconnect(); } catch (e) {}
  bluetoothDevice = null;
  bluetoothCharacteristic = null;
}
window.forgetPrinter = forgetPrinter;

// ตัดการเชื่อมต่อเดิมให้เสร็จก่อนเริ่มเชื่อมต่อใหม่ (Web Bluetooth ไม่มี Promise สำหรับ disconnect)
async function disconnectBluetoothPrinter() {
  const device = bluetoothDevice;
  bluetoothCharacteristic = null;
  try {
    if (device?.gatt?.connected) {
      device.gatt.disconnect();
      await sleep(350);
    }
  } catch (err) {
    console.warn('ตัดการเชื่อมต่อเครื่องพิมพ์เดิมไม่สำเร็จ:', err);
  } finally {
    bluetoothDevice = null;
  }
  return device;
}

async function connectBluetoothPrinter({ forceReconnect = false, retryCount = 1 } = {}) {
  if (!navigator.bluetooth) throw new Error('เบราว์เซอร์นี้ไม่รองรับ Web Bluetooth');
  if (!window.isSecureContext) throw new Error('Web Bluetooth ต้องเปิดผ่าน HTTPS เท่านั้น');

  // ทุกการกดพิมพ์: ตัดของเดิมจริง แล้วดึงเครื่องที่ตั้งค่าไว้มาตรวจและเชื่อมต่อใหม่
  if (forceReconnect) {
    const previousDevice = await disconnectBluetoothPrinter();
    const savedPrinter = getSavedPrinter();
    // บาง Chrome Android ไม่มี getDevices(): ใช้อุปกรณ์ที่เคยจับคู่ในหน้าเดียวกันได้
    // แต่ต้องตรวจ id ให้ตรงกับเครื่องที่บันทึกไว้เสมอ
    if (previousDevice?.id && savedPrinter?.id === previousDevice.id) {
      bluetoothDevice = previousDevice;
    } else {
      bluetoothDevice = await findConfiguredPrinterForAutoConnect(true);
      if (!bluetoothDevice) throw new Error('ไม่พบเครื่องพิมพ์ที่ตั้งค่าไว้');
    }
  }

  if (bluetoothCharacteristic && bluetoothDevice?.gatt?.connected) {
    return bluetoothCharacteristic;
  }

  if (!bluetoothDevice) {
    bluetoothDevice = await findConfiguredPrinterForAutoConnect();
    if (!bluetoothDevice) throw new Error('ไม่พบเครื่องพิมพ์ที่ตั้งค่าไว้');
  }

  bluetoothDevice.addEventListener('gattserverdisconnected', () => {
    bluetoothCharacteristic = null;
  });

  let lastError;
  // เครื่องที่เพิ่งเปิดอาจต้องใช้เวลาประกาศตัวใน Bluetooth: รอแล้วรีเช็กเงียบ ๆ
  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    try {
      const server = await bluetoothDevice.gatt.connect();
      const services = await server.getPrimaryServices();
      if (services.length === 0) throw new Error('ไม่พบ service พิมพ์');

      for (const service of services) {
        const chars = await service.getCharacteristics();
        const writable = chars.find(c => c.properties.writeWithoutResponse || c.properties.write);
        if (writable) {
          bluetoothCharacteristic = writable;
          return writable;
        }
      }
      throw new Error('ไม่พบ characteristic ที่เขียนข้อมูลได้');
    } catch (err) {
      lastError = err;
      bluetoothCharacteristic = null;
      try { bluetoothDevice?.gatt?.disconnect(); } catch (e) {}
      if (attempt === retryCount) break;

      await sleep(1100);
      // กรณี Chrome ดึงอุปกรณ์เดิมได้ ให้รับ object ใหม่มาเชื่อมต่อ โดยไม่เปิดตัวเลือก
      const refreshedDevice = await findConfiguredPrinterForAutoConnect(true);
      if (refreshedDevice) bluetoothDevice = refreshedDevice;
    }
  }

  throw new Error(`เชื่อมต่อเครื่องพิมพ์ไม่ได้: ${lastError?.message || 'เครื่องพิมพ์ยังไม่พร้อมใช้งาน'}`);
}

async function configureBluetoothPrinter() {
  if (!navigator.bluetooth) throw new Error('เบราว์เซอร์นี้ไม่รองรับ Web Bluetooth');
  if (!window.isSecureContext) throw new Error('Web Bluetooth ต้องเปิดผ่าน HTTPS เท่านั้น');

  forgetPrinter();
  const device = await navigator.bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: PRINTER_SERVICES
  });
  bluetoothDevice = device;
  try {
    await connectBluetoothPrinter();
    savePrinter(device);
    sessionWithoutPrinter = false;
    showToast(`ตั้งค่าเครื่องพิมพ์ ${device.name || 'Bluetooth Printer'} เรียบร้อยแล้ว`);
  } catch (error) {
    forgetPrinter();
    throw new Error(`เชื่อมต่อเครื่องพิมพ์ไม่ได้: ${error.message}`);
  }
}

function showPrinterStartupDialog(message, { allowSelect = false } = {}) {
  showAppDialog(message, {
    title: 'เครื่องพิมพ์',
    actionLabel: allowSelect ? 'เลือกเครื่องพิมพ์' : 'รับทราบ',
    cancelLabel: allowSelect ? 'ไม่พิมพ์' : '',
    onAction: allowSelect ? async () => {
      try {
        // requestDevice ต้องเรียกตรงจากการกดของผู้ใช้ ก่อนแสดง Dialog โหลด
        await selectConfiguredPrinter();
        showPrintLoadingDialog('กำลังเชื่อมต่อเครื่องพิมพ์...');
        await connectBluetoothPrinter();
        sessionWithoutPrinter = false;
        showToast('เชื่อมต่อเครื่องพิมพ์เรียบร้อยแล้ว');
      } catch (error) {
        showAppDialog(`เชื่อมต่อเครื่องพิมพ์ไม่ได้: ${error.message}`, { title: 'เครื่องพิมพ์' });
      } finally {
        removePrintLoadingDialog();
      }
    } : null,
    onCancel: allowSelect ? () => {
      sessionWithoutPrinter = true;
      scanWithoutPrinter = true;
    } : null
  });
}

async function closeStaffApplication() {
  releaseStaffUsageOnDisconnect();
  clearInterval(window.scannerTimer);
  try {
    if (html5QrCode?.isScanning) await html5QrCode.stop();
  } catch (error) {}
  try {
    bluetoothDevice?.gatt?.disconnect();
  } catch (error) {}

  // PWA แบบ standalone บางระบบอนุญาตให้ปิดจากการกดของผู้ใช้โดยตรง
  window.close();

  // Safari/Chrome บางรุ่นไม่อนุญาตให้เว็บไซต์ปิดหน้าต่างที่ผู้ใช้เปิดเอง
  window.setTimeout(() => {
    if (window.closed) return;
    document.body.innerHTML = `
      <main style="min-height:100dvh; display:grid; place-items:center; padding:24px; background:#435f52; color:#fff; text-align:center; box-sizing:border-box;">
        <section>
          <h1 style="margin:0 0 10px; font-size:1.35rem;">ปิดการใช้งานแล้ว</h1>
          <p style="margin:0; line-height:1.6;">กรุณาปิดหน้าต่างหรือปัดแอปออก</p>
        </section>
      </main>`;
  }, 150);
}

async function initializePrinterOnMainScreen() {
  const saved = getSavedPrinter();
  if (!saved) {
    showAppDialog('ยังไม่ได้ตั้งค่าเครื่องพิมพ์ ต้องการใช้งานแบบไม่พิมพ์หรือไม่', {
      title: 'เครื่องพิมพ์',
      actionLabel: 'ตกลง',
      cancelLabel: 'ปิด',
      onAction: () => {
        sessionWithoutPrinter = true;
      },
      onCancel: closeStaffApplication
    });
    return;
  }

  try {
    bluetoothDevice = await findConfiguredPrinterForAutoConnect();
    if (!bluetoothDevice) throw new Error('เบราว์เซอร์ไม่พบสิทธิ์เครื่องพิมพ์เดิม');
    await connectBluetoothPrinter({ retryCount: 1 });
  } catch (error) {
    showPrinterStartupDialog(
      `ไม่สามารถเชื่อมต่อเครื่องพิมพ์ ${saved.name} อัตโนมัติได้ กรุณาเปิดเครื่องพิมพ์ แล้วกดเลือกเครื่องพิมพ์เพื่อจับคู่ใหม่`,
      { allowSelect: true }
    );
  }
}

function openPrinterSettings() {
  const saved = getSavedPrinter();
  document.querySelector('#printer-settings-dialog')?.remove();
  document.body.insertAdjacentHTML('beforeend', `
    <div id="printer-settings-dialog" style="position:fixed; inset:0; z-index:20000; display:grid; place-items:center; padding:20px; background:rgba(15,23,42,.55);">
      <section role="dialog" aria-modal="true" aria-labelledby="printer-settings-title" style="width:min(100%,420px); padding:22px; border-radius:16px; background:#fff; color:#1e293b; box-shadow:0 18px 42px rgba(0,0,0,.25);">
        <h2 id="printer-settings-title" style="margin:0 0 10px; font-size:1.2rem; color:#0284c7;">🖨️ ตั้งค่าเครื่องพิมพ์</h2>
        <p style="margin:0 0 18px; line-height:1.55; color:#475569;">${saved ? `เครื่องที่เลือก: <strong>${esc(saved.name)}</strong>` : 'ยังไม่ได้เลือกเครื่องพิมพ์'}<br><small>ระบบจะตรวจสอบการเชื่อมต่อของเครื่องนี้ก่อนพิมพ์ทุกครั้ง</small></p>
        <div id="printer-settings-error" role="alert" style="display:none; margin:0 0 12px; color:#b91c1c;"></div>
        <div style="display:flex; justify-content:flex-end; gap:8px; flex-wrap:wrap;">
          ${saved ? '<button id="btn-clear-printer" type="button" style="padding:9px 12px; border:1px solid #fecaca; border-radius:8px; background:#fff; color:#b91c1c; font-weight:700;">ล้างการตั้งค่า</button>' : ''}
          <button id="btn-close-printer-settings" type="button" style="padding:9px 12px; border:0; border-radius:8px; background:#e2e8f0; color:#334155; font-weight:700;">ปิด</button>
          <button id="btn-select-printer" type="button" style="padding:9px 12px; border:0; border-radius:8px; background:#0284c7; color:#fff; font-weight:700;">${saved ? 'เปลี่ยนเครื่องพิมพ์' : 'เลือกเครื่องพิมพ์'}</button>
        </div>
      </section>
    </div>`);
  const dialog = document.querySelector('#printer-settings-dialog');
  const errorEl = document.querySelector('#printer-settings-error');
  document.querySelector('#btn-close-printer-settings').onclick = () => dialog.remove();
  document.querySelector('#btn-clear-printer')?.addEventListener('click', () => {
    clearSavedPrinter();
    dialog.remove();
    showToast('ล้างการตั้งค่าเครื่องพิมพ์แล้ว');
  });
  document.querySelector('#btn-select-printer').onclick = async event => {
    const button = event.currentTarget;
    button.disabled = true;
    errorEl.style.display = 'none';
    try {
      await configureBluetoothPrinter();
      dialog.remove();
    } catch (error) {
      errorEl.textContent = error.message;
      errorEl.style.display = 'block';
      button.disabled = false;
    }
  };
}

function makeWriter(ch) {
  if (ch.properties.writeWithoutResponse && ch.writeValueWithoutResponse) return d => ch.writeValueWithoutResponse(d);
  if (ch.properties.write && ch.writeValueWithResponse) return d => ch.writeValueWithResponse(d);
  return d => ch.writeValue(d);
}

async function sendBytes(ch, bytes) {
  const write = makeWriter(ch);
  let size = 60, i = 0;
  while (i < bytes.length) {
    try {
      await write(bytes.slice(i, i + size));
      i += size;
      await sleep(25);
    } catch (err) {
      if (size > 20) { size = 20; await sleep(100); continue; }
      throw err;
    }
  }
}

const THAI_COMBINING = /[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]/;

function formatCustomerName(name) {
  if (!name) return '-';
  const parts = String(name).trim().split(/\s+/);
  if (parts.length > 1) {
    return `${parts[0]} xxxx`;
  }
  return name;
}

function createReceiptLines(data, billNo) {
  const now = new Date().toLocaleString('th-TH', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
  const displayName = formatCustomerName(data.name);
  const detailText = `${data.address || '-'}${data.project && data.project !== '-' ? ` ${data.project}` : ''}`;

  const buildBlock = (isMerchantCopy = false) => [
    {
      text: 'D House x Café Amazon',
      align: 'center',
      bold: true,
      isReceiptHeader: true,
      headerDot: isMerchantCopy,
      cornerText: isMerchantCopy ? '(ร้านค้าเก็บ)' : ''
    },
    { 
      leftText: now,
      rightText: `${billNo}`,
      fontSize: 17
    },
    { text: detailText },
    { 
      leftText: `${displayName}`, 
      rightText: `${maskPhoneNumber(data.phone)}`
    },
    { text: '1 สิทธิ์ (ใช้สิทธิ์ฟรี)' },
    { text: `${data.productName}`, bold: true },
    {
      leftText: `ใช้ไปแล้ว: ${data.usedCount + 1} สิทธิ์`,
      rightText: `คงเหลือ: ${data.allLimit - (data.usedCount + 1)} สิทธิ์`
    },
    { text: 'ขอบคุณที่ใช้บริการ', align: 'center' }
  ];

  return {
    original: buildBlock(false),
    copy: buildBlock(true)
  };
}

async function printReceiptESC_POS(characteristic, lines) {
  if (document.fonts) await document.fonts.ready;

  const width = PRINT_WIDTH_DOTS, FONT_PX = 24, LINE_H = 34, PAD = 4;
  const thaiFontStack = '"Noto Sans Thai", "Sarabun", "Tahoma", sans-serif';
  const fontOf = l => `${l.bold ? 'bold ' : ''}${l.fontSize || FONT_PX}px ${thaiFontStack}`;

  const m = document.createElement('canvas').getContext('2d');
  const rows = [];

  for (const l of lines) {
    m.font = fontOf(l);

    if (l.leftText !== undefined || l.rightText !== undefined) {
      rows.push({
        isSplit: true,
        leftText: String(l.leftText ?? ''),
        rightText: String(l.rightText ?? ''),
        bold: l.bold,
        fontSize: l.fontSize
      });
    } else {
      let cur = '';
      for (const ch of String(l.text ?? '')) {
        const tooWide = m.measureText(cur + ch).width > width - PAD * 2;
        if (tooWide && !THAI_COMBINING.test(ch) && cur) { rows.push({ ...l, text: cur }); cur = ch; }
        else cur += ch;
      }
      rows.push({ ...l, text: cur });
    }
  }

  const height = (rows.length * LINE_H) + 20;
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, width, height);
  let currentY = 10;

  ctx.fillStyle = '#000000'; ctx.textBaseline = 'middle';
  rows.forEach((r, i) => {
    ctx.font = fontOf(r);
    const yPos = currentY + i * LINE_H + LINE_H / 2;

    if (r.isReceiptHeader) {
      const brandText = r.text;
      ctx.font = fontOf(r);
      const brandWidth = ctx.measureText(brandText).width;
      const dotFontSize = 38;
      ctx.font = `bold ${dotFontSize}px ${thaiFontStack}`;
      const dotWidth = r.headerDot ? ctx.measureText('●').width : 0;
      const gap = r.headerDot ? 5 : 0;
      const startX = Math.max(PAD, (width - brandWidth - dotWidth - gap) / 2);

      ctx.textAlign = 'left';
      ctx.font = fontOf(r);
      ctx.fillText(brandText, startX, yPos + (r.cornerText ? 5 : 0));
      if (r.headerDot) {
        ctx.font = `bold ${dotFontSize}px ${thaiFontStack}`;
        ctx.fillText('●', startX + brandWidth + gap, yPos + 5);
      }
      if (r.cornerText) {
        ctx.font = `bold ${FONT_PX}px ${thaiFontStack}`;
        ctx.textAlign = 'right';
        ctx.fillText(r.cornerText, width - PAD, yPos - 15);
      }
    } else if (r.isSplit) {
      ctx.textAlign = 'left';
      ctx.fillText(r.leftText, PAD, yPos);

      ctx.textAlign = 'right';
      ctx.fillText(r.rightText, width - PAD, yPos);
    } else {
      ctx.textAlign = 'left';
      if (r.align === 'center') {
        const w = ctx.measureText(r.text).width;
        const x = Math.max(PAD, (width - w) / 2);
        ctx.fillText(r.text, x, yPos);
      } else {
        ctx.fillText(r.text, PAD, yPos);
      }
    }
  });

  const imgData = ctx.getImageData(0, 0, width, height).data;
  await sendBytes(characteristic, new Uint8Array([0x1B, 0x40, 0x1B, 0x33, 0x18]));
  await sleep(50);

  const n1 = width & 0xFF, n2 = (width >> 8) & 0xFF;
  for (let y = 0; y < height; y += 24) {
    const chunkHeader = new Uint8Array([0x1B, 0x2A, 33, n1, n2]);
    const lineBytes = new Uint8Array(width * 3);

    for (let x = 0; x < width; x++) {
      for (let b = 0; b < 24; b++) {
        const targetY = y + b;
        if (targetY < height) {
          const idx = (targetY * width + x) * 4;
          if (0.299 * imgData[idx] + 0.587 * imgData[idx + 1] + 0.114 * imgData[idx + 2] < 140) {
            lineBytes[x * 3 + Math.floor(b / 8)] |= (0x80 >> (b % 8));
          }
        }
      }
    }

    const combined = new Uint8Array(chunkHeader.length + lineBytes.length + 1);
    combined.set(chunkHeader, 0);
    combined.set(lineBytes, chunkHeader.length);
    combined.set([0x0A], chunkHeader.length + lineBytes.length);
    await sendBytes(characteristic, combined);
  }

  await sendBytes(characteristic, new Uint8Array([0x1B, 0x32, 0x1B, 0x64, 0x05, 0x1D, 0x56, 0x42, 0x00]));
  await sleep(300);
}

async function runPrint(data, billNo) {
  // ใช้เฉพาะเครื่องที่ตั้งค่าไว้ และไม่เปิดตัวเลือก Bluetooth ระหว่างการพิมพ์
  const characteristic = await connectBluetoothPrinter();
  const receipts = createReceiptLines(data, billNo);

  await printReceiptESC_POS(characteristic, receipts.original);
  await printReceiptESC_POS(characteristic, receipts.copy);
}

async function printTestReceipt() {
  if (!getSavedPrinter()) {
    showToast('ยังไม่ได้ตั้งค่าเครื่องพิมพ์ กรุณาให้แอดมินตั้งค่าก่อน');
    return;
  }

  try {
    // ต้องทำก่อนเปิด Dialog รอ เพื่อให้ตัวเลือก Bluetooth ของระบบไม่ถูกบัง
    await ensurePrinterReadyFromUserAction();
    showPrintLoadingDialog('กำลังตรวจสอบและส่งใบเสร็จทดสอบ...');
    const characteristic = await connectBluetoothPrinter();
    const testData = {
      name: 'ทดสอบระบบ',
      phone: '-',
      address: 'TEST',
      project: 'ทดสอบระบบ',
      productName: 'ใบเสร็จทดสอบเครื่องพิมพ์',
      usedCount: 0,
      allLimit: 1
    };
    const receipt = createReceiptLines(testData, `TEST-${Date.now().toString().slice(-6)}`);
    await printReceiptESC_POS(characteristic, receipt.original);
    await printReceiptESC_POS(characteristic, receipt.copy);
    showToast('พิมพ์ใบเสร็จทดสอบเรียบร้อยแล้ว');
  } catch (error) {
    console.error('Test print failed:', error);
    //showToast(`พิมพ์ทดสอบไม่ได้: ${error.message}`);
  } finally {
    removePrintLoadingDialog();
  }
}

// ===== ระบบสแกนกล้อง QR Code =====
async function startScanner({ allowWithoutPrinter = false } = {}) {
  const readerEl = document.querySelector('#reader');
  const btn = document.querySelector('#btn-toggle-camera');
  const manageButton = document.querySelector('#btn-manage-member');
  const testPrintButton = document.querySelector('#btn-test-print');
  const salesReportButton = document.querySelector('#btn-sales-report');
  const scannerStatus = document.querySelector('#scanner-status');
  if (!readerEl) return;
  scanWithoutPrinter = Boolean(allowWithoutPrinter || sessionWithoutPrinter);

  if (!scanWithoutPrinter && supportsBluetoothPrinting()) {
    const savedPrinter = getSavedPrinter();
    let printerError = null;
    if (!savedPrinter) {
      printerError = new Error('ยังไม่ได้ตั้งค่าเครื่องพิมพ์');
    } else {
      try {

        // ปุ่มเปิดกล้องต้องไม่เรียก Bluetooth chooser เพราะกล่องระบบจะแสดง URL ของเว็บไซต์
        // ใช้สิทธิ์อุปกรณ์เดิมที่เคยอนุญาตและเชื่อมต่อเบื้องหลังเท่านั้น
        if (!bluetoothDevice || bluetoothDevice.id !== savedPrinter.id) {
          bluetoothDevice = await findConfiguredPrinterForAutoConnect();
          if (!bluetoothDevice) {
            throw new Error(`ไม่พบเครื่องพิมพ์ที่ตั้งไว้ (${savedPrinter.name}) กรุณาเชื่อมต่อจากเมนูตั้งค่าเครื่องพิมพ์ก่อนเปิดกล้อง`);
          }
        }

        showPrintLoadingDialog('กำลังตรวจสอบการเชื่อมต่อเครื่องพิมพ์...');
        await connectBluetoothPrinter();
      } catch (error) {
        printerError = error;
      } finally {
        removePrintLoadingDialog();
      }
    }

    if (printerError) {
      const continueWithoutPrinter = await showConfirmDialog(
        `(${printerError.message})\nหรือต้องการใช้งานแบบไม่พิมพ์หรือไม่?`,
        {
          title: 'ไม่พบเครื่องพิมพ์',
          confirmLabel: 'ตกลง',
          cancelLabel: 'ปิด'
        }
      );
      if (!continueWithoutPrinter) {
        await closeStaffApplication();
        return;
      }
      sessionWithoutPrinter = true;
      scanWithoutPrinter = true;
    }
  }

  isProcessingScan = false;
  readerEl.style.display = 'block';
  if (manageButton) manageButton.style.display = 'none';
  if (testPrintButton) testPrintButton.style.display = 'none';
  if (salesReportButton) salesReportButton.style.display = 'none';
  if (scannerStatus) scannerStatus.textContent = '';
  if (btn) {
    btn.textContent = '❌ ปิดกล้องสแกน';
    btn.style.background = '#dc2626';
  }

  if (!html5QrCode) {
    const scannerOptions = window.Html5QrcodeSupportedFormats?.QR_CODE
      ? { formatsToSupport: [window.Html5QrcodeSupportedFormats.QR_CODE] }
      : undefined;
    html5QrCode = new Html5Qrcode('reader', scannerOptions);
  }

  // ไม่จำกัดกรอบสแกน เพื่อให้อ่านได้ทันทีแม้ QR ไม่อยู่กึ่งกลางกล้อง
  const config = { fps: 10, disableFlip: false };

  try {
    await html5QrCode.start(
      { facingMode: 'environment' },
      config,
      async (decodedText) => {
        if (isProcessingScan) return;
        isProcessingScan = true;
        if (scannerStatus) scannerStatus.textContent = 'อ่าน QR สำเร็จ กำลังค้นหาข้อมูล...';
        await stopScanner();
        
        const scanPayload = parseScanPayload(decodedText);
        await processPhoneQuery(scanPayload.searchKey, scanPayload.productId, scanPayload.expiresAt, scanPayload.memberPhone);
      },
      () => {}
    );
  } catch (err) {
    console.error('Camera Error:', err);
    showToast('ไม่สามารถเปิดกล้องได้: ' + err.message);
    if (scannerStatus) scannerStatus.textContent = 'ไม่สามารถเปิดกล้องได้';
    stopScanner();
  }
}

function parseScanPayload(rawText) {
  if (!rawText) return { searchKey: '', productId: null, expiresAt: null };
  const str = String(rawText).trim();

  // QR ของ PWA Client เป็น JSON: couponId, productId, address, phone, expiresAt
  try {
    const payload = JSON.parse(str);
    const searchKey = payload.couponId || payload.Coupon_No || payload.phone || payload.Phone_No;
    if (searchKey) {
      return {
        searchKey: String(searchKey).trim(),
        productId: payload.productId ?? payload.Product_ID ?? null,
        expiresAt: payload.expiresAt ?? payload.ExpiresAt ?? null,
        memberPhone: payload.phone ?? payload.Phone_No ?? null
      };
    }
  } catch (e) {}

  try {
    if (str.startsWith('http://') || str.startsWith('https://')) {
      const url = new URL(str);
      const phoneParam = url.searchParams.get('phone') || url.searchParams.get('tel') || url.searchParams.get('code') || url.searchParams.get('key');
      if (phoneParam) return { searchKey: phoneParam.trim(), productId: null };
    }
  } catch (e) {}

  const phoneMatch = str.match(/0\d{8,9}/);
  if (phoneMatch) return { searchKey: phoneMatch[0], productId: null, expiresAt: null };

  const couponMatch = str.match(/CPN-[A-Za-z0-9-]+/i);
  if (couponMatch) return { searchKey: couponMatch[0].toUpperCase(), productId: null, expiresAt: null };

  return { searchKey: str, productId: null, expiresAt: null };
}

async function stopScanner() {
  const readerEl = document.querySelector('#reader');
  const btn = document.querySelector('#btn-toggle-camera');
  const manageButton = document.querySelector('#btn-manage-member');
  const testPrintButton = document.querySelector('#btn-test-print');
  const salesReportButton = document.querySelector('#btn-sales-report');
  const scannerStatus = document.querySelector('#scanner-status');

  if (html5QrCode && html5QrCode.isScanning) {
    try {
      await html5QrCode.stop();
    } catch (e) {}
  }

  if (readerEl) readerEl.style.display = 'none';
  if (manageButton) manageButton.style.display = 'flex';
  if (testPrintButton) testPrintButton.style.display = 'block';
  if (salesReportButton) salesReportButton.style.display = 'block';
  if (scannerStatus) scannerStatus.textContent = '';
  if (btn) {
    btn.textContent = '📷 เปิดกล้องสแกน QR Code';
    btn.style.background = '#059669';
  }
}

// ===== ฟังก์ชันควบคุม Loading Dialog รอพิมพ์ =====
function showPrintLoadingDialog(msg = 'กำลังพิมพ์ใบเสร็จ กรุณารอสักครู่...') {
  removePrintLoadingDialog();
  const dialogHtml = `
    <div id="print-loading-dialog" style="position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.7); display:flex; flex-direction:column; justify-content:center; align-items:center; z-index:99999; color:#fff; pointer-events:all;">
      <div style="background:#fff; color:#1e293b; padding:2rem; border-radius:16px; text-align:center; max-width:320px; width:80%; box-shadow:0 20px 25px -5px rgba(0,0,0,0.3);">
        <div class="spinner" style="border:4px solid #f3f3f3; border-top:4px solid #059669; border-radius:50%; width:48px; height:48px; animation:spin 1s linear infinite; margin:0 auto 1.25rem auto;"></div>
        <h3 id="print-dialog-msg" style="margin:0 0 0.5rem 0; font-size:1.1rem; color:#059669;">🖨️ กำลังดำเนินการ</h3>
        <p id="print-dialog-sub" style="margin:0; font-size:0.9rem; color:#64748b;">${esc(msg)}</p>
        <div aria-label="กำลังทำงาน" style="height:7px; margin-top:16px; overflow:hidden; border-radius:999px; background:#dbeafe;"><div style="width:45%; height:100%; border-radius:inherit; background:#059669; animation:loading-progress 1.1s ease-in-out infinite alternate;"></div></div>
      </div>
      <style>
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        @keyframes loading-progress { from { transform:translateX(-80%); } to { transform:translateX(210%); } }
      </style>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', dialogHtml);
}

function updatePrintLoadingMessage(msg) {
  const subEl = document.querySelector('#print-dialog-sub');
  if (subEl) subEl.textContent = msg;
}

function removePrintLoadingDialog() {
  document.querySelector('#print-loading-dialog')?.remove();
}

const PRODUCT_IMAGE_PATHS = {
  '1': 'public/assets/image/black-coffee.webp',
  '2': 'public/assets/image/espresso.webp',
  '3': 'public/assets/image/tea-with-milk.webp'
};
const DEFAULT_PRODUCT_IMAGE_PATH = 'public/assets/image/icon-main.png';

function resolveProductImage(productId, productName, providedImage) {
  if (providedImage) {
    try {
      return new URL(providedImage, document.baseURI).href;
    } catch (error) {
      console.warn('URL รูปสินค้าไม่ถูกต้อง กำลังใช้รูปสำรอง:', providedImage);
    }
  }
  const normalizedId = String(productId ?? '').trim().replace(/\.0+$/, '');
  let imagePath = PRODUCT_IMAGE_PATHS[normalizedId];
  const name = String(productName || '').toLowerCase();
  if (!imagePath && (name.includes('แบล็ค') || name.includes('black'))) imagePath = PRODUCT_IMAGE_PATHS['1'];
  if (!imagePath && (name.includes('เอสเปรส') || name.includes('espresso'))) imagePath = PRODUCT_IMAGE_PATHS['2'];
  if (!imagePath && (name.includes('ชานม') || name.includes('milk tea'))) imagePath = PRODUCT_IMAGE_PATHS['3'];
  return new URL(imagePath || DEFAULT_PRODUCT_IMAGE_PATH, document.baseURI).href;
}

function renderProductImage(productId, productName, providedImage, size = 64) {
  const imageUrl = resolveProductImage(productId, productName, providedImage);
  const fallbackUrl = new URL(DEFAULT_PRODUCT_IMAGE_PATH, document.baseURI).href;
  return `<img src="${esc(imageUrl)}" alt="${esc(productName || 'สินค้า')}" style="width:${size}px; height:${size}px; flex:0 0 ${size}px; object-fit:contain; border-radius:10px; border:1px solid #e2e8f0; background:#f8fafc;" onerror="this.onerror=null;this.src='${esc(fallbackUrl)}'">`;
}

function applyScannedProductFallback(data, scannedProductId) {
  const products = {
    '1': { name: 'แบล็คคอฟฟี (เย็น)', image: 'public/assets/image/black-coffee.webp', price: 60 },
    '2': { name: 'เอสเปรสโซ (เย็น)', image: 'public/assets/image/espresso.webp', price: 60 },
    '3': { name: 'ชานม (เย็น)', image: 'public/assets/image/tea-with-milk.webp', price: 50 }
  };
  const normalizeProductId = value => String(value ?? '').trim().replace(/\.0+$/, '');
  const databaseProductId = normalizeProductId(data?.productId);
  const qrProductId = normalizeProductId(scannedProductId);
  // หากรหัสจากฐานข้อมูลไม่ตรงรายการ ให้ใช้รหัสที่มากับ QR แทน
  const productId = products[databaseProductId] ? databaseProductId : qrProductId || databaseProductId;
  const product = products[productId];

  if (!product) return data;

  return {
    ...data,
    productId,
    productName: data?.productName && data.productName !== 'ไม่ได้เลือกสินค้า' ? data.productName : product.name,
    productImage: resolveProductImage(productId, product.name, data?.productImage),
    productPrice: Number(data?.productPrice || product.price || 0)
  };
}

function supportsBluetoothPrinting() {
  return Boolean(navigator.bluetooth && window.isSecureContext);
}

function renderAirPrintReceipt(data, billNo) {
  const printedAt = new Date().toLocaleString('th-TH');
  const remainingBenefits = Math.max(0, data.allLimit - (data.usedCount + 1));
  app.innerHTML = `
    <div class="staff-page airprint-page">
      <div class="staff-page-header">
        <button class="back" id="btn-close-airprint" type="button" aria-label="กลับ"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg></button>
        <h3>ใบเสร็จรับสิทธิ์</h3>
      </div>
      <main id="airprint-receipt" class="airprint-receipt">
        <h1>D House x Café Amazon</h1>
        <p>ใบเสร็จรับสิทธิ์คูปอง</p>
        <hr>
        <p class="airprint-date">${esc(printedAt)}</p>
        <p class="airprint-row"><span>เลขที่บิล: ${esc(billNo)}</span><span>${esc(data.address)}</span></p>
        <p class="airprint-row"><span>${esc(formatCustomerName(data.name))}</span><span>${esc(maskPhoneNumber(data.phone))}</span></p>
        <hr>
        <p>จำนวน: 1 สิทธิ์ (ใช้สิทธิ์ฟรี)</p>
        <p class="airprint-product">${esc(data.productName)}</p>
        <p>ใช้ไปแล้ว: ${data.usedCount + 1} สิทธิ์</p>
        <p>คงเหลือ: ${remainingBenefits} สิทธิ์</p>
        ${data.project && data.project !== '-' ? `<p>หมายเหตุ: ${esc(data.project)}</p>` : ''}
        <hr>
        <p class="airprint-thanks">ขอบคุณที่ใช้บริการ</p>
      </main>
      <div class="airprint-actions">
        <p>เลือกเครื่องพิมพ์ AirPrint จากเมนูพิมพ์ของ iPhone/iPad</p>
        <button id="btn-airprint" class="primary" type="button">🖨️ พิมพ์ด้วย AirPrint</button>
        <button id="btn-finish-airprint" class="secondary" type="button">เสร็จสิ้น</button>
      </div>
    </div>`;

  document.querySelector('#btn-close-airprint').onclick = renderMainUI;
  document.querySelector('#btn-finish-airprint').onclick = renderMainUI;
  document.querySelector('#btn-airprint').onclick = () => window.print();
}

function getLocalDateValue(date = new Date()) {
  const offsetDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return offsetDate.toISOString().slice(0, 10);
}

function parseReportDate(value) {
  const parts = String(value || '').split('-').map(Number);
  if (parts.length !== 3 || parts.some(part => !Number.isInteger(part))) return new Date();
  return new Date(parts[0], parts[1] - 1, parts[2]);
}

function formatReportDate(value) {
  return parseReportDate(value).toLocaleDateString('th-TH', {
    day: '2-digit',
    month: 'long',
    year: 'numeric'
  });
}

function showReportDatePicker(initialValue) {
  return new Promise(resolve => {
    document.querySelector('#report-date-picker')?.remove();
    let selectedDate = parseReportDate(initialValue);
    let visibleMonth = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1);

    document.body.insertAdjacentHTML('beforeend', `
      <div id="report-date-picker" style="position:fixed; inset:0; z-index:50001; display:grid; place-items:center; padding:20px; background:rgba(15,23,42,.58);">
        <section role="dialog" aria-modal="true" aria-labelledby="report-date-picker-title" style="width:min(100%,380px); overflow:hidden; border-radius:18px; background:#fff; color:#1e293b; box-shadow:0 22px 50px rgba(0,0,0,.3);">
          <header style="padding:18px 20px; background:#0284c7; color:#fff;">
            <div id="report-date-picker-title" style="font-size:.9rem; opacity:.9;">เลือกวันที่รายงาน</div>
            <div id="report-date-selected" style="margin-top:5px; font-size:1.35rem; font-weight:800;"></div>
          </header>
          <div style="padding:14px 16px 10px;">
            <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
              <button id="report-date-prev" type="button" aria-label="เดือนก่อนหน้า" style="width:42px; height:42px; border:0; border-radius:50%; background:#e0f2fe; color:#0369a1; font-size:24px;">‹</button>
              <strong id="report-date-month" style="font-size:1.05rem;"></strong>
              <button id="report-date-next" type="button" aria-label="เดือนถัดไป" style="width:42px; height:42px; border:0; border-radius:50%; background:#e0f2fe; color:#0369a1; font-size:24px;">›</button>
            </div>
            <div style="display:grid; grid-template-columns:repeat(7,1fr); text-align:center; color:#64748b; font-size:.78rem; font-weight:700;">
              ${['อา','จ','อ','พ','พฤ','ศ','ส'].map(day => `<span style="padding:7px 0;">${day}</span>`).join('')}
            </div>
            <div id="report-date-days" style="display:grid; grid-template-columns:repeat(7,1fr); gap:3px;"></div>
          </div>
          <footer style="display:flex; justify-content:flex-end; gap:8px; padding:10px 16px 16px;">
            <button id="report-date-today" type="button" style="margin-right:auto; padding:10px 12px; border:0; border-radius:9px; background:#e0f2fe; color:#0369a1; font-weight:700;">วันนี้</button>
            <button id="report-date-cancel" type="button" style="padding:10px 14px; border:0; border-radius:9px; background:#e2e8f0; color:#334155; font-weight:700;">ยกเลิก</button>
            <button id="report-date-confirm" type="button" style="padding:10px 16px; border:0; border-radius:9px; background:#0284c7; color:#fff; font-weight:700;">ตกลง</button>
          </footer>
        </section>
      </div>`);

    const picker = document.querySelector('#report-date-picker');
    const finish = value => {
      picker.remove();
      resolve(value);
    };
    const toValue = date => getLocalDateValue(date);
    const renderCalendar = () => {
      document.querySelector('#report-date-selected').textContent = formatReportDate(toValue(selectedDate));
      document.querySelector('#report-date-month').textContent = visibleMonth.toLocaleDateString('th-TH', { month: 'long', year: 'numeric' });
      const daysContainer = document.querySelector('#report-date-days');
      const year = visibleMonth.getFullYear();
      const month = visibleMonth.getMonth();
      const firstDay = new Date(year, month, 1).getDay();
      const dayCount = new Date(year, month + 1, 0).getDate();
      const cells = Array(firstDay).fill('<span></span>');
      for (let day = 1; day <= dayCount; day += 1) {
        const candidate = new Date(year, month, day);
        const isSelected = toValue(candidate) === toValue(selectedDate);
        const isToday = toValue(candidate) === getLocalDateValue();
        cells.push(`<button type="button" data-day="${day}" style="aspect-ratio:1; border:${isToday ? '1px solid #0284c7' : '1px solid transparent'}; border-radius:50%; background:${isSelected ? '#0284c7' : 'transparent'}; color:${isSelected ? '#fff' : '#1e293b'}; font:inherit; font-weight:${isSelected ? '800' : '500'};">${day}</button>`);
      }
      daysContainer.innerHTML = cells.join('');
      daysContainer.querySelectorAll('[data-day]').forEach(button => {
        button.onclick = () => {
          selectedDate = new Date(year, month, Number(button.dataset.day));
          renderCalendar();
        };
      });
    };

    document.querySelector('#report-date-prev').onclick = () => {
      visibleMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() - 1, 1);
      renderCalendar();
    };
    document.querySelector('#report-date-next').onclick = () => {
      visibleMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 1);
      renderCalendar();
    };
    document.querySelector('#report-date-today').onclick = () => {
      selectedDate = new Date();
      visibleMonth = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1);
      renderCalendar();
    };
    document.querySelector('#report-date-cancel').onclick = () => finish(null);
    document.querySelector('#report-date-confirm').onclick = () => finish(toValue(selectedDate));
    renderCalendar();
  });
}

function showSalesReportDetail(bill) {
  document.querySelector('#sales-report-detail-dialog')?.remove();
  const saleDate = bill.InsertDate ? new Date(bill.InsertDate).toLocaleString('th-TH') : '-';
  document.body.insertAdjacentHTML('beforeend', `
    <div id="sales-report-detail-dialog" style="position:fixed; inset:0; z-index:50001; display:grid; place-items:center; padding:20px; background:rgba(15,23,42,.6);">
      <section role="dialog" aria-modal="true" aria-labelledby="sales-report-detail-title" style="width:min(100%,430px); max-height:calc(100dvh - 40px); overflow:auto; padding:22px; border-radius:18px; background:#fff; color:#1e293b; box-shadow:0 22px 50px rgba(0,0,0,.3);">
        <h2 id="sales-report-detail-title" style="margin:0 0 16px; color:#0284c7; font-size:1.2rem;">ข้อมูลผู้ใช้สิทธิ์</h2>
        <div style="display:grid; gap:9px; line-height:1.5;">
          <div><strong>เลขที่บิล:</strong> ${esc(bill.Bill_No || '-')}</div>
          <div><strong>วันที่ทำรายการ:</strong> ${esc(saleDate)}</div>
          <div><strong>ชื่อ:</strong> ${esc(bill.memberName || '-')}</div>
          <div><strong>เบอร์โทร:</strong> ${esc(maskPhoneNumber(bill.memberPhone))}</div>
          <div><strong>รายละเอียด / บ้านเลขที่:</strong> ${esc(bill.memberAddress || '-')}</div>
          <div><strong>หมายเหตุ:</strong> ${esc(bill.memberRemark || '-')}</div>
          <div><strong>สินค้า:</strong> ${esc(bill.productName || '-')}</div>
          <div><strong>ราคา:</strong> ฿${Number(bill.productPrice || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
          <div><strong>ใช้สิทธิ์แล้ว:</strong> ${Number(bill.memberUsedCount || 0)} / ${Number(bill.memberAllLimit || 0)} ครั้ง</div>
          <div><strong>จำนวนสิทธิ์ต่อวัน:</strong> ${Number(bill.memberDayLimit || 1)} ครั้ง</div>
        </div>
        <div style="display:flex; justify-content:flex-end; margin-top:20px;">
          <button id="btn-close-sales-report-detail" type="button" style="padding:10px 16px; border:0; border-radius:9px; background:#0284c7; color:#fff; font-weight:700;">ปิด</button>
        </div>
      </section>
    </div>`);
  document.querySelector('#btn-close-sales-report-detail').onclick = () => document.querySelector('#sales-report-detail-dialog')?.remove();
}

async function openSalesReport(dateValue = getLocalDateValue()) {
  app.classList.add('member-management-screen');
  app.innerHTML = `
    <div id="sales-report-modal" class="staff-page" style="min-height:100vh; color:#1e293b;">
      <div style="padding:1rem; background:#fff; border-bottom:1px solid #cbd5e1; display:flex; align-items:center; gap:.5rem; z-index:10;">
        <button class="back" id="btn-close-sales-report" type="button" aria-label="กลับ"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg></button>
        <h3 style="margin:0; font-size:1.1rem; color:#0284c7;">📊 รายงานการขาย</h3>
      </div>
      <main style="flex:1; max-width:1000px; width:100%; margin:0 auto; padding:20px; box-sizing:border-box;">
        <section style="padding:16px; border:1px solid #cbd5e1; border-radius:12px; background:#fff; box-shadow:0 4px 6px -1px rgba(0,0,0,.05);">
          <label for="sales-report-date" style="display:block; margin-bottom:8px; font-weight:700;">เลือกวันที่</label>
          <button id="sales-report-date" type="button" style="width:100%; display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:16px; padding:11px 13px; border:1px solid #cbd5e1; border-radius:8px; background:#fff; color:#1e293b; font:inherit; text-align:left;">
            <span id="sales-report-date-label">${esc(formatReportDate(dateValue))}</span>
            <span aria-hidden="true" style="font-size:1.25rem;">📅</span>
          </button>
          <div id="sales-report-content" aria-live="polite"></div>
        </section>
      </main>
    </div>`;

  document.querySelector('#btn-close-sales-report').onclick = renderMainUI;
  let selectedReportDate = dateValue;
  const loadReport = async () => {
    const selectedDate = selectedReportDate;
    const content = document.querySelector('#sales-report-content');
    content.innerHTML = '<p style="text-align:center; color:#64748b;">กำลังโหลดรายงาน...</p>';
    try {
      const bills = await window.staffApi.getSalesReport(selectedDate);
      const total = bills.reduce((sum, bill) => sum + Number(bill.productPrice || 0), 0);
      content.innerHTML = `
        <div style="display:flex; justify-content:space-between; gap:12px; margin-bottom:12px; padding:12px; background:#ecfdf5; border-radius:10px; color:#065f46; font-weight:700;">
          <span>${bills.length} รายการ</span><span>ยอดขาย ฿${total.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        </div>
        ${bills.length ? `<div style="display:grid; gap:10px;">${bills.map((bill, index) => `
          <article style="padding:13px; border:1px solid #e2e8f0; border-radius:10px; background:#fff; display:flex; gap:12px; align-items:center;">
            ${renderProductImage(bill.Product_Type || bill.productId, bill.productName, bill.productImage, 64)}
            <div style="min-width:0; flex:1;">
              <div style="display:flex; justify-content:space-between; gap:12px; font-weight:700;"><span>${esc(bill.Bill_No || '-')}</span><span>฿${Number(bill.productPrice || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></div>
              <div style="margin-top:5px; color:#334155;">${esc(bill.productName || '-')}</div>
              <div style="margin-top:5px; color:#475569; font-size:.88rem;">${esc(bill.memberName || '-')} · ${esc(maskPhoneNumber(bill.memberPhone))}</div>
              <div style="margin-top:4px; color:#64748b; font-size:.86rem;">${bill.InsertDate ? new Date(bill.InsertDate).toLocaleString('th-TH') : '-'}</div>
              <button type="button" data-sales-detail-index="${index}" style="margin-top:8px; padding:7px 10px; border:1px solid #bae6fd; border-radius:8px; background:#f0f9ff; color:#0369a1; font-weight:700;">แสดงข้อมูลเพิ่มเติม</button>
            </div>
          </article>`).join('')}</div>` : '<p style="padding:24px; text-align:center; color:#64748b; background:#fff; border-radius:10px;">ไม่พบรายการขายในวันที่เลือก</p>'}`;
      content.querySelectorAll('[data-sales-detail-index]').forEach(button => {
        button.onclick = () => showSalesReportDetail(bills[Number(button.dataset.salesDetailIndex)]);
      });
    } catch (error) {
      content.innerHTML = '';
      showAppDialog(error.message || 'ไม่สามารถโหลดรายงานการขายได้', { title: 'รายงานการขาย' });
    }
  };
  document.querySelector('#sales-report-date').onclick = async () => {
    const confirmedDate = await showReportDatePicker(selectedReportDate);
    if (!confirmedDate) return;
    selectedReportDate = confirmedDate;
    document.querySelector('#sales-report-date-label').textContent = formatReportDate(selectedReportDate);
    await loadReport();
  };
  await loadReport();
}

function isCouponExpired(expiresAt) {
  const value = Number(expiresAt);
  if (!Number.isFinite(value) || value <= 0) return false;
  const expiryMs = value < 1e12 ? value * 1000 : value;
  return Date.now() >= expiryMs;
}

async function processPhoneQuery(phone, scannedProductId = null, expiresAt = null, memberPhone = null) {
  showPrintLoadingDialog('กำลังค้นหาข้อมูลสมาชิก...');

  try {
    if (isCouponExpired(expiresAt)) {
      throw new Error('คูปองหมดอายุแล้ว กรุณาให้ลูกค้าสร้างคูปองใหม่');
    }
    const data = applyScannedProductFallback(
      await window.staffApi.checkCouponInfo(phone, memberPhone),
      scannedProductId
    );
    if (!data.productId || !data.productName || data.productName === 'ไม่ได้เลือกสินค้า') {
      throw new Error('QR_PRODUCT_NOT_FOUND');
    }
    data.couponExpiresAt = expiresAt;
    removePrintLoadingDialog();
    renderClientDetailPage(data);
  } catch (err) {
    removePrintLoadingDialog();
    const message = String(err?.message || '');
    if (message.includes('QR_PRODUCT_NOT_FOUND') || message.includes('ไม่พบข้อมูลสมาชิก') || message.includes('ไม่พบคูปอง') || message.includes('ไม่ได้เลือกสินค้า')) {
      showAppDialog('ไม่พบข้อมูลในระบบ หรือ QR Code ไม่ถูกต้อง กรุณาตรวจสอบแล้วลองอีกครั้ง', { title: 'ไม่พบ QR Code' });
    } else {
      showAppDialog('เกิดข้อผิดพลาด: ' + message, { title: 'สแกน QR ไม่สำเร็จ' });
    }
  }
}

// ===== หน้าแสดงรายละเอียดสมาชิก (ขยายแสดงผลแบบ Full Screen) =====
function renderClientDetailPage(data) {
  const displayName = formatCustomerName(data.name);

  const hasCouponOrProduct = Boolean(
    data.productId && 
    data.productName && 
    data.productName !== 'ไม่ได้เลือกสินค้า' && 
    data.couponNo && 
    data.couponNo !== 'ไม่มีคูปองที่ใช้งานอยู่'
  );

  const imgUrl = resolveProductImage(data.productId, data.productName, data.productImage || data.imageUrl || data.product_image);

  const modalHtml = `
    <div id="client-detail-modal" class="staff-page">
      
      <div class="staff-page-header">
        <button class="back" id="btn-close-detail" type="button" aria-label="กลับ"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg></button>
        <h3>ข้อมูลสมาชิก</h3>
      </div>

      <div style="max-width:500px; width:100%; margin:0 auto; padding:1.25rem; box-sizing:border-box;">
        <div style="border:1px solid #e5e7eb; border-radius:12px; padding:1.25rem; background:#fff; box-shadow:0 4px 6px -1px rgba(0,0,0,0.05);">
          <h3 style="margin:0 0 0.75rem 0; color:#059669; border-bottom:2px solid #059669; padding-bottom:0.4rem;">👤 รายละเอียดข้อมูลสมาชิก</h3>
          
          <div style="display:flex; flex-direction:column; gap:0.4rem; font-size:0.95rem; color:#334155;">
            <p style="margin:0;"><strong>ชื่อ:</strong> ${esc(displayName)}</p>
            <p style="margin:0;"><strong>เบอร์โทร:</strong> ${esc(maskPhoneNumber(data.phone))}</p>
            <p style="margin:0;"><strong>รายละเอียด / บ้านเลขที่:</strong> ${esc(data.address)}</p>
            <p style="margin:0;"><strong>หมายเหตุ:</strong> ${esc(data.project || '-')}</p>
            <p style="margin:0;"><strong>คูปอง:</strong> <span style="color:#059669; font-weight:bold;">${esc(data.couponNo || '-')}</span></p>
            <p style="margin:0;"><strong>สินค้า:</strong> <span style="color:#0284c7; font-weight:bold;">${esc(data.productName)}</span></p>
          </div>

          <div style="display:flex; justify-content:center; margin:1rem 0;">
            ${renderProductImage(data.productId, data.productName, imgUrl, 200)}
          </div>

          <p style="margin:0.75rem 0 0.25rem 0; font-size:0.95rem; color:#334155;">
            <strong>สิทธิ์ที่ใช้ไป:</strong> <span style="color:#d97706; font-weight:bold;">${data.usedCount}</span> / ${data.allLimit} ครั้ง
          </p>
          
          <div style="margin-top:1.25rem; display:flex; flex-direction:column; gap:0.6rem;">
            ${
              hasCouponOrProduct
                ? scanWithoutPrinter
                  ? `<button id="btn-confirm-redeem" style="width:100%; padding:0.9rem; background:#059669; color:#fff; border:none; border-radius:8px; font-size:1rem; font-weight:bold; cursor:pointer; box-shadow:0 2px 4px rgba(0,0,0,0.1);">✅ ยืนยันใช้สิทธิ์ (ไม่พิมพ์)</button>`
                  : `<div style="display:flex; gap:.6rem;">
                      <button id="btn-confirm-redeem" style="flex:1; padding:0.9rem; background:#059669; color:#fff; border:none; border-radius:8px; font-size:1rem; font-weight:bold; cursor:pointer; box-shadow:0 2px 4px rgba(0,0,0,0.1);">🖨️ พิมพ์ใบเสร็จ</button>
                      <button id="btn-confirm-no-print" style="padding:.9rem; background:#64748b; color:#fff; border:none; border-radius:8px; font-size:.95rem; font-weight:bold; cursor:pointer;">ไม่พิมพ์</button>
                    </div>`
                : `<div style="background:#fffbebe6; color:#b45309; padding:0.75rem; border-radius:8px; text-align:center; font-size:0.9rem; border:1px solid #fef3c7;">
                    ⚠️ ไม่พบคูปองหรือสินค้าที่เปิดใช้งานในขณะนี้ (ไม่สามารถพิมพ์ใบเสร็จได้)
                  </div>`
            }
            <button id="btn-open-history" style="width:100%; padding:0.65rem; background:#f1f5f9; color:#334155; border:1px solid #cbd5e1; border-radius:8px; font-size:0.9rem; cursor:pointer;">
              📜 ดูประวัติการใช้สิทธิ์
            </button>
          </div>
        </div>
      </div>

    </div>
  `;

  app.innerHTML = modalHtml;
  document.querySelector('#btn-close-detail').onclick = renderMainUI;

  document.querySelector('#btn-open-history').onclick = () => {
    openHistoryModal(data.phone, data);
  };

  if (hasCouponOrProduct) {
    const confirmRedeem = async (withoutPrinting = false) => {
      // ตรวจอีกครั้งก่อนสร้างบิลหรือสั่งพิมพ์ เผื่อคูปองหมดอายุระหว่างเปิดหน้านี้
      if (isCouponExpired(data.couponExpiresAt)) {
        showAppDialog('คูปองหมดอายุแล้ว กรุณาให้ลูกค้าสร้างคูปองใหม่', { title: 'คูปองหมดอายุ' });
        return;
      }

      const useAirPrint = !withoutPrinting && !supportsBluetoothPrinting();
      if (!withoutPrinting && !useAirPrint) {
        try {
          // ต้องทำก่อนเปิด Dialog รอ เพื่อให้ตัวเลือก Bluetooth ของระบบไม่ถูกบัง
          await ensurePrinterReadyFromUserAction();
        } catch (error) {
          showAppDialog(`เชื่อมต่อเครื่องพิมพ์ไม่ได้: ${error.message}`, { title: 'เครื่องพิมพ์' });
          return;
        }
      }

      showPrintLoadingDialog('กำลังตรวจสอบสถานะคูปอง...');

      try {
        // ต้องผ่านการตรวจ Coupon_No ล่าสุดจากฐานข้อมูลก่อน จึงค่อยเชื่อมต่อเครื่องพิมพ์
        await window.staffApi.validateCouponForRedeem(data.phone, data.couponNo);

        updatePrintLoadingMessage('กำลังสร้างเลขบิล...');
        const generatedBillNo = await window.staffApi.generateBillNo();
        if (!withoutPrinting && !useAirPrint) {
          updatePrintLoadingMessage('กำลังส่งสั่งพิมพ์ไปยังเครื่องพิมพ์ Bluetooth...');
          await runPrint(data, generatedBillNo);
        }

        updatePrintLoadingMessage('กำลังบันทึกข้อมูลการใช้สิทธิ์...');
        await window.staffApi.commitRedeemTransaction(data, generatedBillNo);

        removePrintLoadingDialog();
        if (withoutPrinting) {
          showToast('🎉 ออกใบเสร็จและใช้สิทธิ์เรียบร้อยแล้ว (ไม่พิมพ์)');
          renderMainUI();
        } else if (useAirPrint) {
          showToast('ยืนยันใช้สิทธิ์แล้ว กรุณาเลือกพิมพ์ด้วย AirPrint');
          renderAirPrintReceipt(data, generatedBillNo);
        } else {
          showToast('🎉 พิมพ์ใบเสร็จและใช้สิทธิ์เรียบร้อยแล้ว');
          renderMainUI();
        }

      } catch (err) {
        console.error(err);
        removePrintLoadingDialog();
        if (String(err.message || '').includes('คูปองหมดอายุ')) {
          showAppDialog('คูปองหมดอายุแล้ว กรุณาให้ลูกค้าสร้างคูปองใหม่', { title: 'คูปองหมดอายุ' });
        } else {
          const errorMessage = String(err?.message ?? '').trim()
            || 'ไม่สามารถเชื่อมต่อเครื่องพิมพ์ที่ตั้งค่าไว้ได้ กรุณาเปิดเครื่องพิมพ์แล้วลองอีกครั้ง';
          showAppDialog(`การทำรายการถูกยกเลิก: ${errorMessage}`, { title: 'ทำรายการไม่สำเร็จ' });
        }
      }
    };
    document.querySelector('#btn-confirm-redeem')?.addEventListener('click', () => confirmRedeem(scanWithoutPrinter));
    document.querySelector('#btn-confirm-no-print')?.addEventListener('click', () => confirmRedeem(true));
  }
}

// ===== หน้าประวัติการใช้สิทธิ์ (ขยายแสดงผลแบบ Full Screen) =====
async function openHistoryModal(phone, clientData, onClose) {
  const modalHtml = `
    <div id="history-modal" class="staff-page">
      
      <div style="padding:1rem; background:#fff; border-bottom:1px solid #e2e8f0; display:flex; align-items:center; gap:0.5rem;">
        <button class="back" id="btn-close-history" type="button" aria-label="กลับ"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg></button>
        <h3 style="margin:0; font-size:1.1rem; color:#1e293b;">ประวัติการใช้สิทธิ์</h3>
      </div>

      <div style="max-width:600px; width:100%; margin:0 auto; padding:1.25rem; box-sizing:border-box; overflow-y:auto; flex:1;">
        <div style="border:1px solid #e5e7eb; border-radius:12px; padding:1.25rem; background:#fff; box-shadow:0 4px 6px -1px rgba(0,0,0,0.05);">
          <h3 style="margin:0 0 1rem 0; color:#059669; border-bottom:2px solid #059669; padding-bottom:0.4rem;">📜 ประวัติการใช้สิทธิ์ (${maskPhoneNumber(phone)})</h3>
          <div id="history-list-body">
            <p style="text-align:center; color:#666; padding:2rem 0;">กำลังดึงประวัติการใช้สิทธิ์...</p>
          </div>
        </div>
      </div>

    </div>
  `;

  app.innerHTML = modalHtml;
  document.querySelector('#btn-close-history').onclick = onClose || (() => renderClientDetailPage(clientData));

  try {
    const historyList = await window.staffApi.getHistory(phone);
    const bodyEl = document.querySelector('#history-list-body');

    if (!historyList || historyList.length === 0) {
      bodyEl.innerHTML = `<p style="text-align:center; color:#64748b; padding:2rem 0;">ยังไม่มีประวัติการใช้สิทธิ์</p>`;
      return;
    }

    bodyEl.innerHTML = historyList.map(item => `
      <div style="border-bottom:1px solid #e2e8f0; padding:0.85rem 0; display:flex; gap:0.75rem; justify-content:space-between; align-items:center;">
        ${renderProductImage(item.productId, item.productName, item.productImage, 58)}
        <div style="min-width:0; flex:1;">
          <div style="font-weight:bold; color:#1e293b; font-size:0.95rem;">${esc(item.productName)}</div>
          <div style="font-size:0.8rem; color:#64748b; margin-top:2px;">เลขบิล: ${esc(item.billNo)} | คูปอง: ${esc(item.couponNo)}</div>
        </div>
        <div style="font-size:0.85rem; color:#059669; font-weight:bold; text-align:right; flex:0 0 auto;">
          ${esc(item.useDate)}
        </div>
      </div>
    `).join('');
  } catch (err) {
    document.querySelector('#history-list-body').innerHTML = `
      <p style="text-align:center; color:#dc2626; padding:1rem;">เกิดข้อผิดพลาด: ${esc(err.message)}</p>
    `;
  }
}

// ===== หน้าจัดการตารางสมาชิก House Management (ขยายแสดงผลแบบ Full Screen) =====
async function openHouseManagementModal() {
  if (Number(adminSession?.accessLevel) !== 1) {
    showToast('กรุณายืนยันสิทธิ์แอดมินก่อนจัดการสมาชิก');
    return;
  }
  app.classList.add('member-management-screen');
  const modalHtml = `
    <div id="house-modal" class="staff-page">
      
      <div style="padding:1rem; background:#fff; border-bottom:1px solid #cbd5e1; display:flex; align-items:center; gap:0.5rem; z-index:10;">
        <button class="back" id="btn-close-house-modal" type="button" aria-label="กลับ"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg></button>
        <h3 style="margin:0; font-size:1.1rem; color:#0284c7;">🏠 จัดการข้อมูลสมาชิก</h3>
      </div>

      <div style="flex:1; overflow-y:auto; padding:1rem; max-width:1000px; width:100%; margin:0 auto; box-sizing:border-box;">
        
        <div style="border:1px solid #cbd5e1; border-radius:12px; background:#fff; overflow:hidden; box-shadow:0 4px 6px -1px rgba(0,0,0,0.05);">
          
          <div style="padding:0.85rem 1rem; background:#f8fafc; border-bottom:1px solid #e2e8f0; display:flex; gap:0.5rem; flex-wrap:wrap; justify-content:space-between; align-items:center;">
            <div style="display:flex; gap:0.5rem; flex:1; min-width:240px;">
              <input type="text" id="house-search-input" style="flex:1; padding:0.6rem; border:1px solid #cbd5e1; border-radius:6px; font-size:0.9rem;" />
              <button id="btn-house-search" style="padding:0.6rem 1rem; background:#0284c7; color:#fff; border:none; border-radius:6px; font-weight:bold; cursor:pointer; font-size:0.9rem;">🔍 ค้นหา</button>
            </div>
            <div style="display:flex; gap:0.5rem;">
              <button id="btn-house-refresh" style="padding:0.6rem 1rem; background:#475569; color:#fff; border:none; border-radius:6px; font-weight:bold; cursor:pointer; font-size:0.9rem;">🔄 รีเฟรช</button>
              <button id="btn-printer-settings" style="padding:0.6rem 1rem; background:#0284c7; color:#fff; border:none; border-radius:6px; font-weight:bold; cursor:pointer; font-size:0.9rem;">🖨️ ตั้งค่าเครื่องพิมพ์</button>
              <button id="btn-open-add-house" style="padding:0.6rem 1rem; background:#059669; color:#fff; border:none; border-radius:6px; font-weight:bold; cursor:pointer; font-size:0.9rem;">➕ เพิ่มข้อมูลใหม่</button>
            </div>
          </div>

          <div style="padding:1rem; overflow-x:auto;">
            <table style="width:100%; border-collapse:collapse; font-size:0.9rem; text-align:left; min-width:900px;">
              <thead>
                <tr style="background:#059669; color:#fff;">
                  <th style="padding:0.75rem; text-align:center;">ประเภทผู้ใช้</th>
                  <th style="padding:0.75rem; text-align:center;">สถานะเข้าใช้งาน</th>
                  <th style="padding:0.75rem;">ชื่อ-นามสกุล</th>
                  <th style="padding:0.75rem;">เบอร์โทรศัพท์</th>
                  <th style="padding:0.75rem;">รายละเอียด /บ้านเลขที่</th>
                  <th style="padding:0.75rem;">หมายเหตุ</th>
                  <th style="padding:0.75rem; text-align:center;">สิทธิ์/วัน</th>
                  <th style="padding:0.75rem; text-align:center;">ใช้ไปแล้ว</th>
                  <th style="padding:0.75rem; text-align:center;">สิทธิ์ทั้งหมด</th>
                  <th style="padding:0.75rem; text-align:center;">จัดการ</th>
                </tr>
              </thead>
              <tbody id="house-table-body">
                <tr><td colspan="10" style="text-align:center; padding:2rem; color:#64748b;">กำลังโหลดข้อมูล...</td></tr>
              </tbody>
            </table>
          </div>

        </div>

      </div>

    </div>
  `;

  app.innerHTML = modalHtml;
  document.querySelector('#btn-close-house-modal').onclick = async () => {
    try {
      if (!await window.staffApi.hasAdminUser()) {
        showToast('ต้องเพิ่ม User ที่เป็นแอดมินอย่างน้อย 1 User ก่อน จึงจะออกจากหน้านี้ได้');
        return;
      }
      renderMainUI();
    } catch (error) {
      showToast(error.message);
    }
  };

  document.querySelector('#btn-house-refresh').onclick = async () => {
    const searchInput = document.querySelector('#house-search-input');
    if (searchInput) searchInput.value = '';
    await loadHouseTableData();
    
  };

  document.querySelector('#btn-printer-settings').onclick = openPrinterSettings;

  document.querySelector('#btn-house-search').onclick = filterHouseTable;
  document.querySelector('#house-search-input').onkeyup = (e) => {
    if (e.key === 'Enter') filterHouseTable();
  };

  document.querySelector('#btn-open-add-house').onclick = () => {
    openHouseRecordModal('➕ เพิ่มข้อมูลสมาชิกใหม่', false);
  };

  await loadHouseTableData();
}

// ===== หน้าฟอร์ม เพิ่ม / แก้ไข สมาชิก (ขยายแสดงผลแบบ Full Screen) =====
function openHouseRecordModal(title, isEdit = false, record = null) {
  const needsFirstAdmin = !currentHouseDataList.some(item => Number(item.accessLevel) === 1);
  const modalHtml = `
    <div id="house-record-modal" class="staff-page">
      
      <div style="padding:1rem; background:#fff; border-bottom:1px solid #cbd5e1; display:flex; align-items:center; gap:0.5rem;">
        <button class="back" id="btn-close-record-modal" type="button" aria-label="กลับ"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg></button>
        <h3 style="margin:0; font-size:1.1rem; color:#059669;">${esc(title)}</h3>
      </div>

      <div style="max-width:500px; width:100%; margin:0 auto; padding:1.25rem; box-sizing:border-box; overflow-y:auto; flex:1;">
        
        <div style="border:1px solid #cbd5e1; border-radius:12px; background:#fff; overflow:hidden; box-shadow:0 4px 6px -1px rgba(0,0,0,0.05);">
          ${!isEdit && needsFirstAdmin ? '<div role="alert" style="margin:1.25rem 1.25rem 0; padding:.85rem; border:1px solid #f59e0b; border-radius:8px; background:#fffbeb; color:#92400e; line-height:1.5; font-size:.9rem;"><strong>ต้องสร้าง User แอดมินก่อน</strong><br>กรุณาเลือก “แอดมิน” ในช่องสถานะผู้ใช้งาน แล้วบันทึกข้อมูล จึงจะออกจากหน้าจัดการสมาชิกได้</div>' : ''}
          <form id="house-record-form" style="padding:1.25rem; display:flex; flex-direction:column; gap:0.8rem;">
            <input type="hidden" id="h-field-id" value="${esc(record?.id || '')}" />
            
            <div>
              <label style="font-size:0.85rem; font-weight:bold; color:#475569;">ชื่อ - นามสกุล *</label>
              <input type="text" id="h-field-name" value="${esc(record?.name || '')}" required style="width:100%; padding:0.6rem; border:1px solid #cbd5e1; border-radius:6px; box-sizing:border-box; font-size:0.95rem;" />
            </div>
            <div>
              <label style="font-size:0.85rem; font-weight:bold; color:#475569;">เบอร์โทรศัพท์ *</label>
              <input type="tel" id="h-field-phone" value="${esc(record?.phone || '')}" required style="width:100%; padding:0.6rem; border:1px solid #cbd5e1; border-radius:6px; box-sizing:border-box; font-size:0.95rem;" />
            </div>
            <div>
              <label style="font-size:0.85rem; font-weight:bold; color:#475569;">รายละเอียด /บ้านเลขที่</label>
              <input type="text" id="h-field-address" value="${esc(record?.address || '')}" style="width:100%; padding:0.6rem; border:1px solid #cbd5e1; border-radius:6px; box-sizing:border-box; font-size:0.95rem;" />
            </div>
            <div>
              <label style="font-size:0.85rem; font-weight:bold; color:#475569;">หมายเหตุ</label>
              <input type="text" id="h-field-project" value="${esc(record?.project || '')}" style="width:100%; padding:0.6rem; border:1px solid #cbd5e1; border-radius:6px; box-sizing:border-box; font-size:0.95rem;" />
            </div>
            <div>
              <label style="font-size:0.85rem; font-weight:bold; color:#475569;">สถานะผู้ใช้งาน</label>
              <select id="h-field-access-level" style="width:100%; padding:0.6rem; border:1px solid #cbd5e1; border-radius:6px; box-sizing:border-box; font-size:0.95rem;">
                <option value="0" ${Number(record?.accessLevel ?? 0) === 0 ? 'selected' : ''}>ผู้ใช้งานทั่วไป</option>
                <option value="1" ${Number(record?.accessLevel) === 1 ? 'selected' : ''}>แอดมิน</option>
              </select>
            </div>
            ${isEdit ? `
              <div>
                <label style="font-size:0.85rem; font-weight:bold; color:#475569;">สถานะเข้าใช้งาน</label>
                <select id="h-field-is-use" style="width:100%; padding:0.6rem; border:1px solid #cbd5e1; border-radius:6px; box-sizing:border-box; font-size:0.95rem;">
                  <option value="1" ${record?.isUse ? 'selected' : ''}>กำลังออนไลน์</option>
                  <option value="0" ${!record?.isUse ? 'selected' : ''}>ล๊อคเอ้า</option>
                </select>
              </div>
            ` : '<input type="hidden" id="h-field-is-use" value="0" />'}

            <div id="h-fields-rights" style="display:flex; gap:0.5rem;">
              <div style="flex:1;">
                <label style="font-size:0.8rem; font-weight:bold; color:#475569;">สิทธิ์ / วัน</label>
                <input type="number" id="h-field-quotaPerDay" value="${isEdit ? (record?.quotaPerDay ?? '') : ''}" min="1" style="width:100%; padding:0.6rem; border:1px solid #cbd5e1; border-radius:6px; box-sizing:border-box; font-size:0.95rem;" />
              </div>
              <div style="flex:1;">
                <label style="font-size:0.8rem; font-weight:bold; color:#475569;">สิทธิ์ที่ใช้แล้ว</label>
                <input type="number" id="h-field-usedCount" value="${isEdit ? (record?.usedCount ?? '') : ''}" min="0" style="width:100%; padding:0.6rem; border:1px solid #cbd5e1; border-radius:6px; box-sizing:border-box; font-size:0.95rem;" />
              </div>
              <div style="flex:1;">
                <label style="font-size:0.8rem; font-weight:bold; color:#475569;">สิทธิ์ทั้งหมด</label>
                <input type="number" id="h-field-allLimit" value="${isEdit ? (record?.allLimit ?? '') : ''}" min="1" style="width:100%; padding:0.6rem; border:1px solid #cbd5e1; border-radius:6px; box-sizing:border-box; font-size:0.95rem;" />
              </div>
            </div>

            <div style="margin-top:0.4rem; padding:0.85rem; background:#faf5ff; border-radius:8px; border:2px solid #a855f7; box-shadow:0 2px 8px rgba(126,34,206,0.12);">
              <p style="margin:0; font-size:0.85rem; color:#6b21a8; font-weight:600;">
                ${isEdit ? 'ต้องการรีเซ็ตรหัสผ่านสำหรับเข้าสู่ระบบของสมาชิกรายนี้?' : 'รหัสผ่านเริ่มต้นสำหรับสมาชิกใหม่คือ: 1234'}
              </p>
              ${
                isEdit
                  ? `<button type="button" id="btn-reset-password" style="margin-top:0.6rem; padding:0.55rem 0.9rem; background:#7e22ce; color:#fff; border:none; border-radius:6px; font-weight:bold; cursor:pointer; font-size:0.9rem; box-shadow:0 2px 5px rgba(126,34,206,0.3);">
                      🔄 Reset รหัสผ่านเป็น 1234
                    </button>`
                  : ''
              }
            </div>

            <div style="display:flex; justify-content:flex-end; gap:0.5rem; margin-top:0.8rem;">
              <button type="button" id="btn-cancel-record-modal" style="padding:0.7rem 1.2rem; background:#64748b; color:#fff; border:none; border-radius:6px; cursor:pointer; font-weight:bold;">ยกเลิก</button>
              <button type="submit" style="padding:0.7rem 1.2rem; background:#059669; color:#fff; border:none; border-radius:6px; font-weight:bold; cursor:pointer;">บันทึกข้อมูล</button>
            </div>
          </form>

        </div>

      </div>

    </div>
  `;

  app.innerHTML = modalHtml;

  const closeForm = () => openHouseManagementModal();

  document.querySelector('#btn-close-record-modal').onclick = closeForm;
  document.querySelector('#btn-cancel-record-modal').onclick = closeForm;

  if (isEdit) {
    document.querySelector('#btn-reset-password')?.addEventListener('click', async () => {
      if (!record?.id) return;
      if (await showConfirmDialog('ยืนยันที่จะรีเซ็ตรหัสผ่านของสมาชิกคนนี้กลับเป็น 1234 ใช่หรือไม่?', {
        title: 'รีเซ็ตรหัสผ่าน',
        confirmLabel: 'รีเซ็ต',
        cancelLabel: 'ยกเลิก'
      })) {
        try {
          if (window.staffApi?.resetPassword) {
            await window.staffApi.resetPassword(record.id, '1234');
          } else if (window.staffApi?.saveHouseData) {
            await window.staffApi.saveHouseData({ id: record.id, password: '1234' });
          }
          showToast('รีเซ็ตรหัสผ่านเป็น 1234 เรียบร้อยแล้ว');
        } catch (err) {
          showAppDialog('เกิดข้อผิดพลาดในการรีเซ็ตรหัสผ่าน: ' + err.message, { title: 'รีเซ็ตรหัสผ่านไม่สำเร็จ' });
        }
      }
    });
  }

  const houseForm = document.querySelector('#house-record-form');
  const accessLevelField = document.querySelector('#h-field-access-level');
  const isUseField = document.querySelector('#h-field-is-use');
  const rightsFields = document.querySelector('#h-fields-rights');
  const updateRightsFieldsVisibility = () => {
    const isAdmin = Number(accessLevelField.value) === 1;
    rightsFields.hidden = isAdmin;
    rightsFields.style.display = isAdmin ? 'none' : 'flex';

    rightsFields.querySelectorAll('input').forEach((input) => {
      if (isAdmin) {
        if (!Object.hasOwn(input.dataset, 'beforeAdmin')) {
          input.dataset.beforeAdmin = input.value;
        }
        input.value = '0';
        input.disabled = true;
        return;
      }

      input.disabled = false;
      if (Object.hasOwn(input.dataset, 'beforeAdmin')) {
        input.value = input.dataset.beforeAdmin;
        delete input.dataset.beforeAdmin;
      }

    });
  };

  accessLevelField.addEventListener('change', updateRightsFieldsVisibility);
  updateRightsFieldsVisibility();

  houseForm.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target.matches('button, textarea')) return;

    // Enter ใช้เลื่อนไปช่องถัดไปเท่านั้น จึงไม่ส่งฟอร์มและไม่กระตุ้นปุ่มใด ๆ
    const fields = [...houseForm.querySelectorAll('input:not([type="hidden"]), select, textarea')]
      .filter(field => !field.disabled && field.offsetParent !== null);
    const currentIndex = fields.indexOf(e.target);

    if (currentIndex === -1) return;
    e.preventDefault();
    fields[currentIndex + 1]?.focus();
  });

  houseForm.onsubmit = async (e) => {
    e.preventDefault();
    const id = document.querySelector('#h-field-id').value;
    const accessLevel = parseInt(accessLevelField.value, 10) || 0;
    const isAdmin = accessLevel === 1;
    const quotaInput = document.querySelector('#h-field-quotaPerDay');
    const usedInput = document.querySelector('#h-field-usedCount');
    const allLimitInput = document.querySelector('#h-field-allLimit');
    const quotaVal = isAdmin ? 0 : Number.parseInt(quotaInput.value, 10);
    const usedCountVal = isAdmin ? 0 : Number.parseInt(usedInput.value, 10);
    const allLimitVal = isAdmin ? 0 : Number.parseInt(allLimitInput.value, 10);

    if (!isAdmin) {
      const invalidInput = [quotaInput, usedInput, allLimitInput].find((input) => {
        const value = Number(input.value);
        if (input.value.trim() === '' || !Number.isInteger(value)) return true;
        return input === usedInput ? value < 0 : value <= 0;
      });
      if (invalidInput) {
        await showAppDialog('กรุณากรอกข้อมูลสิทธิ์ให้ครบถ้วน โดยสิทธิ์ / วัน และสิทธิ์ทั้งหมดต้องมากกว่า 0 ส่วนสิทธิ์ที่ใช้แล้วต้องไม่น้อยกว่า 0', {
          title: 'ข้อมูลสิทธิ์ไม่ถูกต้อง'
        });
        invalidInput.focus();
        return;
      }
    }
    
    const payload = {
      id: id || null,
      name: document.querySelector('#h-field-name').value,
      phone: document.querySelector('#h-field-phone').value,
      address: document.querySelector('#h-field-address').value,
      project: document.querySelector('#h-field-project').value,
      quotaPerDay: quotaVal,
      Day_Limit: quotaVal,
      accessLevel,
      isUse: isEdit ? Number(isUseField.value) === 1 : false,
      usedCount: usedCountVal,
      allLimit: allLimitVal
    };

    if (!id) {
      payload.password = '1234';
    }

    try {
      if (window.staffApi?.saveHouseData) {
        await window.staffApi.saveHouseData(payload);
      }
      showToast('บันทึกข้อมูลเรียบร้อยแล้ว');
      closeForm();
    } catch (err) {
      showAppDialog('เกิดข้อผิดพลาดในการบันทึก: ' + err.message, { title: 'บันทึกข้อมูลไม่สำเร็จ' });
    }
  };
}

async function loadHouseTableData() {
  const tbody = document.querySelector('#house-table-body');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="10" style="text-align:center; padding:2rem; color:#64748b;">กำลังโหลดข้อมูล...</td></tr>`;

  try {
    if (window.staffApi?.getHouseTableData) {
      currentHouseDataList = await window.staffApi.getHouseTableData();
    } else {
      currentHouseDataList = [];
    }
    renderHouseTable(currentHouseDataList);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="10" style="text-align:center; padding:2rem; color:#dc2626;">เกิดข้อผิดพลาด: ${esc(err.message)}</td></tr>`;
  }
}

// ===== อัปเดตคอลัมน์การจัดการให้มีปุ่มลบ (🗑️ ลบ) =====
function renderHouseTable(list) {
  const tbody = document.querySelector('#house-table-body');
  if (!tbody) return;

  if (!list || list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" style="text-align:center; padding:2rem; color:#64748b;">ไม่พบข้อมูลสมาชิก</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(item => `
    <tr style="border-bottom:1px solid #e2e8f0;">
      <td style="padding:0.75rem; text-align:center;">
        <span style="display:inline-block; min-width:70px; padding:0.25rem 0.5rem; border-radius:999px; font-size:0.8rem; font-weight:bold; color:#fff; background:${Number(item.accessLevel) === 1 ? '#7c3aed' : '#0284c7'};">
          ${Number(item.accessLevel) === 1 ? 'แอดมิน' : 'ผู้ใช้'}
        </span>
      </td>
      <td style="padding:0.75rem; text-align:center;">
        <span style="display:inline-block; min-width:48px; padding:0.25rem 0.5rem; border-radius:999px; font-size:0.8rem; font-weight:bold; color:#fff; background:${item.isUse ? '#16a34a' : '#64748b'};">
          ${item.isUse ? 'กำลังออนไลน์' : 'ล๊อคเอ้า'}
        </span>
      </td>
      <td style="padding:0.75rem;">${esc(item.name || '-')}</td>
      <td style="padding:0.75rem;">${esc(item.phone || '-')}</td>
      <td style="padding:0.75rem;">${esc(item.address || '-')}</td>
      <td style="padding:0.75rem;">${esc(item.project || '-')}</td>
      <td style="padding:0.75rem; text-align:center;">${item.quotaPerDay ?? 1}</td>
      <td style="padding:0.75rem; text-align:center;">${item.usedCount ?? 0}</td>
      <td style="padding:0.75rem; text-align:center;">${item.allLimit ?? 10}</td>
      <td style="padding:0.75rem; text-align:center;">
        <div style="display:flex; gap:0.4rem; justify-content:center;">
          <button type="button" data-history-id="${esc(item.id)}" style="padding:0.4rem 0.6rem; background:#2563eb; color:#fff; border:none; border-radius:4px; cursor:pointer; font-size:0.8rem; font-weight:bold; white-space:nowrap;">📜 ประวัติ</button>
          <button onclick="editHouseRecord('${esc(item.id)}')" style="padding:0.4rem 0.6rem; background:#eab308; color:#fff; border:none; border-radius:4px; cursor:pointer; font-size:0.8rem; font-weight:bold;">✏️ แก้ไข</button>
          <button onclick="deleteHouseRecord('${esc(item.id)}', '${esc(item.name)}')" style="padding:0.4rem 0.6rem; background:#dc2626; color:#fff; border:none; border-radius:4px; cursor:pointer; font-size:0.8rem; font-weight:bold;">🗑️ ลบ</button>
        </div>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('[data-history-id]').forEach(button => {
    button.addEventListener('click', () => {
      const member = currentHouseDataList.find(item => String(item.id) === button.dataset.historyId);
      if (!member?.phone) {
        showToast('ไม่พบเบอร์โทรศัพท์ของสมาชิก');
        return;
      }
      app.classList.remove('member-management-screen');
      openHistoryModal(member.phone, member, openHouseManagementModal);
    });
  });
}

// ===== เพิ่มฟังก์ชันลบข้อมูลสมาชิก =====
async function deleteHouseRecord(id, name) {
  if (!id) return;

  if (await showConfirmDialog(`คุณแน่ใจหรือไม่ว่าต้องการลบข้อมูลสมาชิก "${name || 'รายนี้'}" ?\nการดำเนินการนี้ไม่สามารถย้อนกลับได้`, {
    title: 'ลบข้อมูลสมาชิก',
    confirmLabel: 'ลบข้อมูล',
    cancelLabel: 'ยกเลิก'
  })) {
    try {
      if (window.staffApi?.deleteHouseData) {
        await window.staffApi.deleteHouseData(id);
      } else {
        throw new Error('ไม่พบฟังก์ชันลบข้อมูล (window.staffApi.deleteHouseData)');
      }
      showToast('ลบข้อมูลสมาชิกเรียบร้อยแล้ว');
      await loadHouseTableData();
    } catch (err) {
      if (String(err?.message || '').includes('ไม่สามารถลบได้ เนื่องจากมีการใช้สิทธิ์ไปแล้ว')) {
        showAppDialog('ไม่สามารถลบได้ เนื่องจากมีการใช้สิทธิ์ไปแล้ว', { title: 'ลบข้อมูลสมาชิก' });
      } else {
        showAppDialog('เกิดข้อผิดพลาดในการลบข้อมูล: ' + err.message, { title: 'ลบข้อมูลไม่สำเร็จ' });
      }
    }
  }
}
window.deleteHouseRecord = deleteHouseRecord;

function filterHouseTable() {
  const query = document.querySelector('#house-search-input')?.value.toLowerCase().trim();
  if (!query) {
    renderHouseTable(currentHouseDataList);
    return;
  }

  const filtered = currentHouseDataList.filter(item => {
    return (item.name && item.name.toLowerCase().includes(query)) ||
           (item.phone && item.phone.includes(query)) ||
           (item.project && item.project.toLowerCase().includes(query)) ||
           (item.address && item.address.toLowerCase().includes(query));
  });

  renderHouseTable(filtered);
}

function editHouseRecord(id) {
  const record = currentHouseDataList.find(item => String(item.id) === String(id));
  if (!record) return;
  openHouseRecordModal('✏️ แก้ไขข้อมูลสมาชิก', true, record);
}

async function openAdminLoginDialog() {
  try {
    const hasAdmin = await window.staffApi.hasAdminUser();
    if (!hasAdmin) {
      adminSession = { accessLevel: 1, initialSetup: true };
      await openHouseManagementModal();
      return;
    }
  } catch (error) {
    showToast(error.message);
    return;
  }

  const dialogHtml = `
    <div id="admin-login-dialog" style="position:fixed; inset:0; z-index:20000; display:grid; place-items:center; padding:20px; background:rgba(20,40,29,.62);">
      <form id="admin-login-form" style="width:min(100%,360px); display:grid; gap:14px; padding:22px; border-radius:18px; background:#fffaf4; box-shadow:0 20px 45px rgba(0,0,0,.28);">
        <div>
          <h2 style="margin:0; color:#194832; font-size:1.25rem;">ยืนยันสิทธิ์ผู้ดูแล</h2>
          <p style="margin:5px 0 0; color:#766b5e; font-size:.9rem;">เข้าสู่ระบบด้วย User และ Password ของแอดมิน</p>
        </div>
        <label style="display:grid; gap:6px; color:#2c241d;">User (เบอร์โทรศัพท์)
          <input id="admin-username" name="username" type="text" inputmode="tel" autocomplete="username" required>
        </label>
        <label style="display:grid; gap:6px; color:#2c241d;">Password
          <span style="position:relative; display:block;">
            <input id="admin-password" name="password" type="password" autocomplete="current-password" required style="width:100%; padding-right:48px; box-sizing:border-box;">
            <button id="btn-toggle-admin-password" type="button" aria-label="แสดงรหัสผ่าน" title="แสดงรหัสผ่าน" style="position:absolute; top:50%; right:7px; transform:translateY(-50%); width:36px; height:36px; display:grid; place-items:center; padding:0; border:0; border-radius:9px; background:#e8efe4; color:#194832; font-size:18px; cursor:pointer;"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg></button>
          </span>
        </label>
        <p id="admin-login-error" role="alert" style="display:none; margin:0; color:#b63f35; font-size:.85rem;"></p>
        <div style="display:flex; justify-content:flex-end; gap:10px;">
          <button id="btn-cancel-admin-login" type="button" style="padding:10px 14px; border-radius:10px; background:#e8efe4; color:#194832; font-weight:700;">ยกเลิก</button>
          <button id="btn-confirm-admin-login" type="submit" style="padding:10px 14px; border-radius:10px; background:#256b45; color:#fff; font-weight:700;">เข้าสู่ระบบ</button>
        </div>
      </form>
    </div>`;

  document.body.insertAdjacentHTML('beforeend', dialogHtml);
  const dialog = document.querySelector('#admin-login-dialog');
  const passwordInput = document.querySelector('#admin-password');
  const passwordToggle = document.querySelector('#btn-toggle-admin-password');
  passwordToggle.onclick = () => {
    const willShow = passwordInput.type === 'password';
    passwordInput.type = willShow ? 'text' : 'password';
    passwordToggle.innerHTML = willShow ? '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 10.6a2 2 0 0 0 2.8 2.8"/><path d="M9.9 4.2A10.8 10.8 0 0 1 12 4c5.5 0 9 5 9 8a9.7 9.7 0 0 1-2 3.6"/><path d="M6.6 6.6C4.4 8 3 10.2 3 12c0 3 3.5 8 9 8a10.5 10.5 0 0 0 3.4-.6"/></svg>' : '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
    passwordToggle.setAttribute('aria-label', willShow ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน');
    passwordToggle.title = willShow ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน';
  };
  document.querySelector('#btn-cancel-admin-login').onclick = () => dialog.remove();
  document.querySelector('#admin-login-form').onsubmit = async (event) => {
    event.preventDefault();
    const submitButton = document.querySelector('#btn-confirm-admin-login');
    const errorEl = document.querySelector('#admin-login-error');
    submitButton.disabled = true;
    submitButton.textContent = 'กำลังตรวจสอบ...';
    errorEl.style.display = 'none';

    try {
      const formData = new FormData(event.currentTarget);
      adminSession = await window.staffApi.verifyAdminCredentials(formData.get('username'), formData.get('password'));
      dialog.remove();
      openHouseManagementModal();
    } catch (error) {
      errorEl.textContent = error.message;
      errorEl.style.display = 'block';
      submitButton.disabled = false;
      submitButton.textContent = 'เข้าสู่ระบบ';
    }
  };
}

// ===== หน้าหลัก UI =====
function renderMainUI() {
  scanWithoutPrinter = false;
  app.classList.remove('member-management-screen');
  app.innerHTML = `
    <div class="shell staff-main-shell" style="max-width: 480px; margin: 0 auto; padding: 1rem; font-family: sans-serif; position: relative; min-height: 80vh;">
      <header style="text-align: center; margin-bottom: 1.5rem;">
        <img 
          src="public/assets/image/icon-192.png" 
          alt="D House X Cafe Amazon Logo" 
          style="width: 80px; height: 80px; object-fit: contain; margin-bottom: 0.5rem; border-radius: 12px;"
        >
        <h1 style="color: #fff; margin: 0; font-size: 1.5rem;">D House x Café Amazon</h1>
        <p style="color: #f5eee3; margin-top: 0.25rem;">สแกน QR Code เพื่อใช้สิทธิ์และพิมพ์ใบเสร็จ</p>
      </header>

      <div class="card" style="border: 1px solid #ddd; border-radius: 12px; padding: 1rem; background: #fff; margin-bottom: 1rem; text-align: center;">
        <div id="reader" style="width:100%; max-width:100%; box-sizing:border-box; border-radius:8px; overflow:hidden; background:#000; display:none; margin-bottom:0.75rem;"></div>
        <p id="scanner-status" aria-live="polite" style="margin:0 0 .75rem; color:#766b5e; font-size:.85rem;"></p>
        <button id="btn-toggle-camera" style="width: 100%; padding: 0.85rem; background: #059669; color: #fff; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; font-size: 1rem;">
          📷 เปิดกล้องสแกน QR Code
        </button>
      </div>

      <button id="btn-sales-report" type="button" style="position:fixed; left:50%; transform:translateX(-50%); bottom:20px; min-height:52px; padding:.72rem .95rem; border:0; border-radius:999px; background:#0284c7; color:#fff; font-size:.9rem; font-weight:700; box-shadow:0 4px 12px rgba(0,0,0,.25); cursor:pointer; z-index:1000; display:flex; align-items:center; justify-content:center;">
        📊 รายงาน
      </button>

      <button 
        id="btn-manage-member" 
        title="จัดการข้อมูลสมาชิก"
        style="
          position: fixed;
          bottom: 20px;
          left: 20px;
          width: 52px;
          height: 52px;
          border-radius: 50%;
          background: #0284c7;
          color: #fff;
          border: none;
          font-size: 1.4rem;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          box-shadow: 0 4px 10px rgba(0, 0, 0, 0.25);
          z-index: 1000;
          transition: transform 0.2s;
        "
        onmouseover="this.style.transform='scale(1.08)'"
        onmouseout="this.style.transform='scale(1)'"
      >
        👤
      </button>
      <button
        id="btn-test-print"
        type="button"
        title="ทดสอบพิมพ์"
        style="
          position:fixed;
          right:20px;
          bottom:20px;
          padding:0.72rem 0.95rem;
          border:0;
          border-radius:999px;
          background:#0284c7;
          color:#fff;
          font-weight:bold;
          cursor:pointer;
          font-size:.9rem;
          box-shadow:0 4px 10px rgba(0,0,0,.25);
          z-index:1000;
        ">
        🖨️ ทดสอบ
      </button>
    </div>
  `;

  document.querySelector('#btn-manage-member').onclick = () => openAdminLoginDialog();

  document.querySelector('#btn-toggle-camera').onclick = () => {
    if (html5QrCode && html5QrCode.isScanning) stopScanner();
    else startScanner();
  };

  document.querySelector('#btn-test-print').onclick = printTestReceipt;
  document.querySelector('#btn-sales-report').onclick = () => openSalesReport();

  setTimeout(showInstallGuide, 400);
  if (!printerStartupChecked) {
    printerStartupChecked = true;
    setTimeout(initializePrinterOnMainScreen, 700);
  }
}

// โหลดหน้าจอหลักเมื่อเริ่มต้น
renderMainUI();
keepStaffScreenAwake();
