export function isAllowedStudioNavigation(candidate, appUrl = 'guardian://studio/') {
  try {
    const target = new URL(candidate);
    const app = new URL(appUrl);
    return target.protocol === 'guardian:'
      && target.hostname === 'studio'
      && target.port === ''
      && target.username === ''
      && target.password === ''
      && app.protocol === target.protocol
      && app.hostname === target.hostname
      && app.port === target.port
      && app.username === ''
      && app.password === '';
  } catch {
    return false;
  }
}
