// #475: the app PIN rule of the mobile app, the same as on the desktop (desktop/pin.js): new and changed PINs need at
// least 6 characters (before 4). A shorter PIN set earlier keeps unlocking; after unlocking with it the app asks to
// change it. No Capacitor imports here, so the unit test can load it.

export const MIN_PIN_LENGTH = 6;

export const isShortPin = (pin) => String(pin ?? '').length < MIN_PIN_LENGTH;
