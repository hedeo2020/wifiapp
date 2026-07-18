# Integration Notes

The live Orange Pi image currently contains a proprietary PisoFi Slim PHP app under:

```text
/.cache/tmp/55/05/pfi
```

Its cloud request class calls:

```text
https://pisofiph.com/api
```

for registration, token, license, recovery, update, and status checks.

Do not replace that with forged PisoFi responses. The safer integration path is:

1. Keep the existing captive portal and local database intact.
2. Keep the local console at:

```text
http://192.168.137.235/local-console/index.php
```

3. Add a separate 3DBPoint agent/config that calls:

```text
https://api.3dbpoint.com/api/v1/devices/register
https://api.3dbpoint.com/api/v1/devices/:serial/license
```

4. Use the admin console at:

```text
https://cpanel.3dbpoint.com
```

to issue and revoke 3DBPoint-owned licenses.

This creates a platform you control without depending on the missing PisoFi cloud dashboard credentials.
