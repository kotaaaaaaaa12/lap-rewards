'use strict';
// Japanese text for the notification feature. It extends the table that i18n.js defines (it must load
// right after i18n.js); the entries can be moved into i18n.js at any time.
Object.assign(JA, {
  // screens
  'Notifications': '通知',
  'Get notified when you receive points or your reward request is updated.': 'ポイントを受け取ったときや、景品リクエストが更新されたときにお知らせします。',
  'Turn on notifications': '通知をオンにする',
  'Turn off notifications': '通知をオフにする',
  'Notifications are on for this device.': 'この端末の通知はオンです。',
  'Point changes': 'ポイントの増減',
  'Reward requests': '景品リクエスト',
  'Send a test notification': 'テスト通知を送る',
  'Test notification sent.': 'テスト通知を送信しました。',
  'Notifications turned on.': '通知をオンにしました。',
  'Notifications turned off.': '通知をオフにしました。',
  'Notifications were not allowed.': '通知が許可されませんでした。',
  'Could not turn on notifications.': '通知をオンにできませんでした。',
  'Could not turn off notifications.': '通知をオフにできませんでした。',
  'Could not load the notification settings.': '通知の設定を読み込めませんでした。',
  'Notifications are blocked. Allow them for this site in your browser settings, then reload this page.': '通知がブロックされています。ブラウザの設定でこのサイトの通知を許可してから、このページを再読み込みしてください。',
  'This browser does not support notifications. You can still use all other features.': 'このブラウザは通知に対応していません。その他の機能はそのままご利用いただけます。',
  'On iPhone and iPad, add this app to your Home Screen (Share → Add to Home Screen) and open it from there to turn on notifications.': 'iPhoneとiPadでは、このアプリをホーム画面に追加し(共有 → ホーム画面に追加)、そこから開くと通知をオンにできます。',
  'Signing out also turns off notifications on this device.': 'サインアウトすると、この端末の通知もオフになります。',
  // server messages
  'The notification subscription is invalid.': '通知の登録情報が正しくありません。',
  'Notifications are not supported for this browser.': 'このブラウザでは通知を利用できません。',
  'Notification settings must be true or false.': '通知の設定はオンまたはオフで指定してください。',
  'Turn on notifications on this device first.': 'まずこの端末で通知をオンにしてください。',
});
