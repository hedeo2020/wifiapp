<?php
declare(strict_types=1);

header('Content-Type: application/json');
header('Cache-Control: no-store');

function respond($payload, int $status = 200): void
{
    http_response_code($status);
    echo json_encode($payload, JSON_PRETTY_PRINT);
    exit;
}

function db(): PDO
{
    $env = parse_ini_file('/etc/environment') ?: [];
    $host = $env['KCFGDBH'] ?? 'localhost';
    $name = $env['KCFGDBN'] ?? 'pisofi';
    $user = $env['KCFGDBU'] ?? '';
    $pass = $env['KCFGDBP'] ?? '';

    $pdo = new PDO(
        "mysql:host={$host};dbname={$name};charset=utf8",
        $user,
        $pass,
        [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]
    );
    return $pdo;
}

function one(PDO $pdo, string $sql, array $params = [])
{
    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    return $stmt->fetchColumn();
}

function rows(PDO $pdo, string $sql, array $params = []): array
{
    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    return $stmt->fetchAll();
}

function setting(PDO $pdo, string $key, $default = null)
{
    $stmt = $pdo->prepare('SELECT setting_value FROM settings WHERE setting_key = ? LIMIT 1');
    $stmt->execute([$key]);
    $value = $stmt->fetchColumn();
    return $value === false ? $default : $value;
}

function system_info(PDO $pdo): array
{
    $licenseRaw = setting($pdo, 'license');
    $license = $licenseRaw ? json_decode($licenseRaw, true) : null;

    return [
        'hostname' => trim((string) @shell_exec('hostname')) ?: null,
        'kernel' => trim((string) @shell_exec('uname -a')) ?: null,
        'board' => getenv('BOARD_NAME') ?: null,
        'ip' => $_SERVER['SERVER_ADDR'] ?? null,
        'is_registered' => (int) setting($pdo, 'is_registered', 0),
        'initial_registration' => (int) setting($pdo, 'initial_registration', 0),
        'license' => [
            'present' => is_array($license),
            'type' => $license['licenseType'] ?? null,
            'last_check' => $license['last_check'] ?? null,
            'vendos' => $license['vendos'] ?? 0,
            'desktops' => $license['desktops'] ?? 0,
        ],
        'access_token_present' => trim((string) setting($pdo, 'access_token', '')) !== '',
    ];
}

try {
    $pdo = db();
    $path = trim((string) ($_GET['path'] ?? 'dashboard/stats'), '/');

    switch ($path) {
        case 'status':
            respond(['status' => 'OK', 'data' => system_info($pdo)]);

        case 'dashboard/stats':
        case 'dashboard':
            $activeClients = (int) one($pdo, 'SELECT COUNT(*) FROM active_clients WHERE status = 1');
            $tickets = (int) one($pdo, 'SELECT COUNT(*) FROM tickets');
            $availableTickets = (int) one($pdo, 'SELECT COUNT(*) FROM tickets WHERE status = 1');
            $totalCoins = (float) one($pdo, 'SELECT COALESCE(SUM(amount), 0) FROM insert_coin_logs');
            $todayCoins = (float) one($pdo, 'SELECT COALESCE(SUM(amount), 0) FROM insert_coin_logs WHERE DATE(created_at) = CURDATE()');
            $rates = (int) one($pdo, 'SELECT COUNT(*) FROM rates WHERE status = 1');

            respond([
                'status' => 'OK',
                'data' => [
                    'widgets' => [
                        ['title' => 'Active Clients', 'value' => $activeClients, 'description' => 'Connected or managed sessions'],
                        ['title' => 'WiPass Tickets', 'value' => $availableTickets . ' / ' . $tickets, 'description' => 'Available and total tickets'],
                        ['title' => 'Sales Today', 'value' => number_format($todayCoins, 2), 'description' => 'Inserted coin total today'],
                        ['title' => 'All-Time Coins', 'value' => number_format($totalCoins, 2), 'description' => 'Recorded inserted coin total'],
                        ['title' => 'Rates', 'value' => $rates, 'description' => 'Active WiFi rates'],
                    ],
                    'system' => system_info($pdo),
                ],
            ]);

        case 'clients':
        case 'devices':
            respond([
                'status' => 'OK',
                'data' => rows($pdo, 'SELECT id, mac, ip_address, remaining_time, running_time, download_rate, upload_rate, status, created_at, updated_at FROM active_clients ORDER BY updated_at DESC, created_at DESC LIMIT 100'),
            ]);

        case 'tickets':
        case 'wipass':
            respond([
                'status' => 'OK',
                'data' => rows($pdo, 'SELECT code, amount, connection_time, status, mac, ip_address, client_id, created_at, expires_at FROM tickets ORDER BY created_at DESC LIMIT 100'),
            ]);

        case 'rates':
        case 'licenses':
            respond([
                'status' => 'OK',
                'data' => [
                    'license' => system_info($pdo)['license'],
                    'rates' => rows($pdo, 'SELECT id, coin, time, status, description, created_at, updated_at FROM rates ORDER BY coin ASC, time ASC LIMIT 100'),
                ],
            ]);

        case 'credits':
        case 'credits/balance':
            respond([
                'status' => 'OK',
                'data' => [
                    'coin_logs' => rows($pdo, 'SELECT id, mac, ip_address, previous_amount, amount, description, source, created_at FROM insert_coin_logs ORDER BY created_at DESC LIMIT 100'),
                    'wallet_total' => (float) one($pdo, 'SELECT COALESCE(SUM(wallet), 0) FROM client_accounts'),
                ],
            ]);

        case 'tokens':
            respond([
                'status' => 'OK',
                'data' => [
                    'access_token_present' => system_info($pdo)['access_token_present'],
                    'last_access_token_check' => setting($pdo, 'last_access_token_check'),
                    'note' => 'Token value is intentionally not exposed by the local console.',
                ],
            ]);

        default:
            respond(['status' => 'NG', 'message' => 'Unknown local API path', 'path' => $path], 404);
    }
} catch (Throwable $e) {
    respond(['status' => 'NG', 'message' => $e->getMessage()], 500);
}
