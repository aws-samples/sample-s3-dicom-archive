/**
 * Viewer launch token hand-off (OHIF, SLIM, VolView).
 *
 * The admin and data-user UIs open a viewer with the Cognito access token in the
 * URL FRAGMENT (`#token=...`), never in the query string. A fragment is not sent
 * in any HTTP request, so the token does not reach CloudFront/ALB access logs,
 * the network, or a Referer header.
 *
 * Each viewer reads its token from `?token=` and then strips it. This inline
 * script, injected as the FIRST element of the viewer's <head>, moves the token
 * from the fragment into the query string with history.replaceState (no request
 * is made) before the viewer's own scripts run; the viewer then consumes it and
 * removes it from the address bar and history as before.
 */
export const VIEWER_TOKEN_SHIM = [
  '<script>(function(){try{',
  'var h=location.hash;if(!h||h.indexOf("token=")<0)return;',
  'var hp=new URLSearchParams(h.slice(1));var t=hp.get("token");if(!t)return;',
  'hp.delete("token");var q=new URLSearchParams(location.search);q.set("token",t);',
  'var r=hp.toString();',
  'history.replaceState(history.state,"",location.pathname+"?"+q.toString()+(r?"#"+r:""));',
  '}catch(e){}})();</script>',
].join('');

/**
 * Shell command (CodeBuild) that inserts $VIEWER_TOKEN_SHIM right after the
 * opening <head> tag of the given built index.html. Fails the build if the file
 * has no <head> tag, so a viewer can never ship without the hand-off.
 */
export function injectTokenShimCommand(indexHtmlPath: string): string {
  return `python3 -c "import os,re,sys; f='${indexHtmlPath}'; h=open(f).read(); n=re.subn(r'(<head[^>]*>)', lambda m: m.group(1)+os.environ['VIEWER_TOKEN_SHIM'], h, count=1); sys.exit('no <head> in '+f) if n[1]!=1 else open(f,'w').write(n[0])"`;
}
