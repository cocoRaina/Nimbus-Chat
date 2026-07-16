import { Capacitor, registerPlugin } from '@capacitor/core'

// Bridge to the custom EnvState Android plugin (see
// android/app/src/main/java/.../EnvStatePlugin.java). Reads lightweight ambient
// phone state — ringer mode, audio output route (+ bluetooth device name), and
// Wi-Fi/cellular transport — for injection into the chat prompt. No-op on web.

export type EnvStateResult = {
  ringer: 'silent' | 'vibrate' | 'normal'
  audio: 'speaker' | 'wired' | 'bluetooth'
  btName?: string
  network: 'wifi' | 'cellular' | 'other' | 'none'
  // Ambient light in lux (light sensor, foreground-cached). Absent when the
  // device has no light sensor or no reading has arrived yet.
  lux?: number
}

type EnvStatePlugin = {
  get(): Promise<EnvStateResult>
  requestBluetooth(): Promise<{ granted: boolean }>
}

const EnvState = registerPlugin<EnvStatePlugin>('EnvState')

const isAvailable = (): boolean =>
  Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('EnvState')

export const getEnvStateNative = async (): Promise<EnvStateResult | null> => {
  if (!isAvailable()) return null
  try {
    return await EnvState.get()
  } catch {
    return null
  }
}

// Ask for BLUETOOTH_CONNECT once so the bluetooth device NAME (earbuds vs car)
// becomes readable. Without it we still detect "bluetooth audio connected",
// just unnamed. Safe no-op below Android 12 / on web.
export const requestBluetoothName = async (): Promise<void> => {
  if (!isAvailable()) return
  try {
    await EnvState.requestBluetooth()
  } catch {
    // Silent — falls back to unnamed bluetooth.
  }
}
