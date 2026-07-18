# Pisofi Basic Connection — Orange Pi One

Source: `Pisofi Basic Connection - Orange Pi One.pdf` (one landscape page, supplied 2026-07-18).

## System topology

1. A **12 V DC, 2 A minimum** supply feeds a DC buck converter.
2. The buck converter is specified for **5 V, 3 A minimum** output.
3. A **USB-to-DC-jack cable** carries the converter's 5 V output to the Orange Pi One barrel-power input.
4. The Orange Pi One's onboard Ethernet port connects to the **ISP router**.
5. A USB-to-Ethernet adapter connects an Orange Pi USB port to the external **access point**. Thus, the Orange Pi is placed between the ISP/WAN side and the customer AP/LAN side.
6. A universal coin acceptor connects to Orange Pi GPIO for pulse sensing and enable/disable control.
7. Two external LEDs provide insert-session and power/software-boot status.

## Default portal GPIO configuration shown

| Portal function | Displayed GPIO pin | Required behavior |
|---|---:|---|
| Power Indicator | 15 | Indicates board power and successful software boot |
| Power Switch (optional) | 3 | Physical restart input; triggered by connection to ground |
| Insert Coin Indicator | 14 | Pulsating output used to blink an LED during an insert-coin session |
| Coinslot Enable | 4 | Output that enables/disables the acceptor; polarity depends on configured active-high/active-low trigger level |
| Coinslot Signal | 2 | Input that counts acceptor pulses and converts them to portal credits |
| Bill Acceptor (optional) | 27 | Pulse input like Coinslot Signal, with configurable pulses per amount |
| Insert Coin Reset (optional) | 11 | Physical input that cancels the current insert-coin session so the customer at the machine can start one |
| Peripheral Timer (optional) | 22 | Scheduled output controlled from the admin panel's Job Schedule tab (example: lights) |

The diagram says this is the default setup restored by **Reset Pins**, followed by **Apply Changes**.

## Coin acceptor wiring shown

- The acceptor is a multi-coin/universal electronic acceptor with terminal block and speed/contact markings.
- The diagram explicitly uses the acceptor's **NO** (normally-open) pulse connection.
- The acceptor pulse speed selector is shown/labeled **FAST**.
- **Red** is routed from the 12 V supply/buck input positive node to the acceptor supply.
- **Black** is the shared return/ground, routed between the supply side, acceptor, and Orange Pi GPIO ground.
- **Gray** is the coin pulse/signal path from the acceptor to the Orange Pi header.
- **Green** is the acceptor enable/control path from Orange Pi GPIO.
- A **330-ohm resistor** is drawn in series on the green enable/control path near the acceptor.
- The precise acceptor terminal names/order are not legible in the source; they must be verified from the acceptor model label/manual before energizing it.

## Indicator LED wiring shown

- Green LED: **Insert Indicator (Blinking)**, corresponding to GPIO value 14 in the portal table.
- Red LED: **Power/Boot Up Indicator**, corresponding to GPIO value 15 in the portal table.
- Each LED has its own **330-ohm series resistor**.
- Both LEDs share the black ground/return conductor.
- The diagram does not mark LED anode/cathode explicitly. The physical LED drawing suggests the GPIO drives the resistor/anode side and the other leg returns to ground, but polarity should be confirmed during reconstruction.

## Network roles

| Orange Pi interface | Connected device | Intended side |
|---|---|---|
| Built-in RJ45 Ethernet | ISP router | Upstream/WAN |
| USB port via USB-to-Ethernet adapter | External access point | Downstream/customer LAN |

The diagram does not state interface names, IP subnets, DHCP settings, NAT/firewall rules, captive-portal ports, AP mode, or router/AP configuration. Those must be recovered from the firmware image.

## Important electrical and interpretation cautions

- The buck converter must be adjusted and measured at **5 V before connecting** the Orange Pi.
- The 12 V supply and 5 V converter ratings in the drawing are minimum ratings, not measured operating values.
- Orange Pi GPIO is not 12 V tolerant. Never route the acceptor's 12 V pulse directly into GPIO without confirming that the acceptor output is a dry/open-collector contact and that the shown interface is electrically safe.
- The diagram gives values under the heading **GPIO PIN**, but it does not state whether these are physical 40-pin header positions, WiringOP/wiringPi logical numbers, Linux GPIO line numbers, or Allwinner H3 port identifiers. The firmware's pin library/configuration must establish the numbering scheme before wiring or changing code.
- The drawing is illustrative rather than a formal schematic: it omits voltage labels at individual terminals, transistor/opto-isolation, pull-up/pull-down values, grounding topology details, connector pin numbering, and protection components.
- The color traces help follow the drawing but should not be trusted as a universal cable color standard.

## Firmware-image investigation checklist

When the Orange Pi image is supplied, preserve the original image read-only and record its size and cryptographic hashes first. Then inspect:

1. Partition table, filesystems, bootloader, kernel, device tree, and board identity.
2. GPIO library and numbering convention; map each portal value (15, 3, 14, 4, 2, 27, 11, 22) to the H3 SoC line and physical header pin.
3. GPIO direction, active level, pull resistors, debounce, pulse timing, edge detection, boot defaults, and safe shutdown behavior.
4. Coin/bill pulse-to-credit configuration and database/storage locations.
5. WAN/LAN interface naming and USB-Ethernet chipset/driver.
6. IP addressing, DHCP/DNS, NAT, firewall, traffic shaping, captive portal, vouchers, session accounting, and admin service.
7. Boot services, scheduled jobs, watchdog/restart behavior, web stack, databases, binaries/scripts, package versions, and update mechanism.
8. Credentials, secrets, certificates, unique device identifiers, and licensing material; do not expose or redistribute them.
9. Produce a reproducible component inventory and clean-room rebuild plan rather than modifying the only supplied image.

## Open questions to resolve from hardware or firmware

- Exact Orange Pi header physical-pin mapping for every displayed GPIO number.
- Coin acceptor make/model, terminal order, output voltage/type, pulse width, pulses per denomination, inhibit polarity, and current requirements.
- Whether the enable path really needs only the drawn 330-ohm resistor or uses an omitted transistor/relay/opto-isolator.
- LED polarity and whether both indicator outputs are active-high.
- USB-to-Ethernet chipset and the Linux interface assigned to it.
- Whether the external wireless device is configured strictly as a bridge/AP or also performs routing/DHCP/NAT.

## Captive portal visual references supplied

Two screenshots were supplied on 2026-07-18 as behavioral/layout references.

### Screenshot 1 — customer captive portal/session page

Visible elements and behavior clues:

- Mobile-first page displayed inside an iPhone-style frame.
- Top navigation contains PisoFi branding (`My PisoFi App`) and a hamburger menu.
- Large configurable/banner carousel image.
- Wi-Fi status icon and the text `Discover the power of Piso!`.
- Client identity/status row exposes a MAC address and local client IP in the example.
- A large remaining-session timer includes days, hours, minutes, and seconds.
- Session actions: **Pause**, **Convert**, **Transfer**, a green `nic` control, and **Sign Out**.
- Commercial/navigation actions: **WiFi Rates**, **Charging Rates**, **Stations**, and **Wifi | Charging | WiPass**.
- Primary acquisition controls: blue **Insert Coin** and green **Use WiPass**, with a dropdown.
- Footer reads `© 2019 PisoFi. All Rights Reserved.` and includes a circular notification/bell control.
- The screenshot indicates the portal supports time accounting, pause/resume, time or credit conversion/transfer, voucher/WiPass access, coin insertion, client recognition, and configurable advertising/branding. It does not prove how any of those functions are implemented server-side.

### Screenshot 2 — public feature/marketing view

- Shows a mobile **WiPass Tickets** table with code, amount, duration/time, status/action controls, search, page size, and pagination.
- Advertises these admin capabilities:
  - **Client Management** — extend a client's time, set a speed limit, or disconnect a client.
  - **WiPass Tickets** — generate and sell access tickets.
  - **Customize Rates** — configure time allotted per coin.
  - **Customize** — customize homepage content.
  - **Sales Report** — monitor sales.
  - Additional unspecified functions (`and many more`).
- This image is useful as a product-capability and visual reference, but is not evidence of the exact current admin implementation or API schema.

## Admin dashboard client archive supplied

File: `pisofi-site-copy.zip`

- Size: **1,228,048 bytes**
- SHA-256: `605A1F819CC9C74149E6D9D29F8CE1CB469903FEAB5F9CC2EDBCA49A40038472`
- Capture origin stated in its README: `https://dash.pisofiph.com/dashboard`
- Capture date stated in its README: **2026-07-18**
- Inventory: **24 files** — 11 Nuxt JavaScript bundles, 5 PNG images, 4 webfonts, 1 inline SVG asset, `manifest.json`, `README.md`, and `index.html`.
- The archive references the dashboard host `dash.pisofiph.com` and an API/image host at `recoilnet.pisofiph.com`.

### Routes mapped by the archive

1. `/dashboard`
2. `/dashboard/devices`
3. `/dashboard/devices/transfers`
4. `/dashboard/devices/requests`
5. `/dashboard/devices/history`
6. `/dashboard/licenses/transfers/new`
7. `/dashboard/licenses`
8. `/dashboard/licenses/transfers`
9. `/dashboard/licenses/revocations`
10. `/dashboard/credits`
11. `/dashboard/credits/transfers/vendos`
12. `/dashboard/credits/transfers/desktops`
13. `/dashboard/credits/transfers`
14. `/dashboard/tokens`
15. `/settings/access-token`
16. `/settings`

### Archive limitations and correct use

- This is a browser-visible Nuxt production artifact set, **not** the private source repository.
- It contains no confirmed private backend source, database contents/schema, credentials, tokens, authenticated API response bodies, or live session state.
- Its minified bundles can later help identify client route names, component structure, request paths, payload field names, validation rules, UI text, and expected API interactions.
- Do not execute the bundles or perform live account actions during firmware analysis. Treat the archive as static evidence and compare it with locally recovered firmware files and endpoints.
- The firmware may run a local captive portal distinct from the cloud dashboard. Maintain that boundary when reconstructing architecture: local device services, cloud control-plane services, and browser clients may be separate systems.
