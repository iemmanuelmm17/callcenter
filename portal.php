<?php declare(strict_types=1); require_once __DIR__ . '/includes/bootstrap.php'; ?>
<!doctype html>
<html lang="en" class="bg-slate-950">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>CallScope · Reporting</title>
  <!-- Tabulator (JS + CSS) is injected on first use by the call modal: see
       ensureTabulator() in assets/js/src/app.js. -->
  <link rel="stylesheet" href="assets/css/app.css">
</head>
<body class="min-h-screen bg-slate-950 text-slate-200 antialiased">
  <div id="root"></div>
  <script defer src="https://unpkg.com/react@18/umd/react.production.min.js" crossorigin></script>
  <script defer src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js" crossorigin></script>
  <script defer src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
  <script defer src="assets/js/app.js"></script>
</body>
</html>
