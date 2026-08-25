// Point a plugged-in Android's own localhost:<port> at this dev server (adb reverse), so the
// phone gets a secure context (service workers, push, real PWA install). Silent no-op otherwise.
import { $ } from "bun";

export async function adbReady(): Promise<boolean> {
  if (!Bun.which("adb")) return false;
  const r = await $`adb get-state`.quiet().nothrow();
  return r.exitCode === 0 && r.stdout.toString().trim() === "device";
}
export async function adbReverse(port: number) {
  if (!port || !(await adbReady())) return;
  if ((await $`adb reverse tcp:${port} tcp:${port}`.quiet().nothrow()).exitCode === 0)
    console.log(`  android:  http://localhost:${port} (over usb)`);
}
export async function adbUnreverse(port: number) {
  if (!port || !(await adbReady())) return;
  await $`adb reverse --remove tcp:${port}`.quiet().nothrow();
}
/** open the running server on the phone, Firefox first (old Chrome may not render the app) */
export async function openOnAndroid(port: number) {
  if (!(await adbReady())) { console.error("no authorised Android attached (check `adb devices`)"); return; }
  await $`adb reverse tcp:${port} tcp:${port}`.quiet().nothrow();
  const url = `http://localhost:${port}`;
  const ff = await $`adb shell am start -n org.mozilla.firefox/org.mozilla.fenix.IntentReceiverActivity -a android.intent.action.VIEW -d ${url}`.quiet().nothrow();
  if (!/error|exception/i.test(ff.stdout.toString() + ff.stderr.toString())) { console.log(`opened ${url} on the device (firefox)`); return; }
  const any = await $`adb shell am start -a android.intent.action.VIEW -d ${url}`.quiet().nothrow();
  if (/error|exception/i.test(any.stdout.toString() + any.stderr.toString())) console.error(`couldn't open a browser on the device: ${any.stdout}${any.stderr}`);
  else console.log(`opened ${url} on the device (default browser — Firefox not found)`);
}
