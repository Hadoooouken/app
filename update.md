# Config Override Refactor

## Зачем это сделано

Переопределение `config` через `Planner.init({ settings })` не давало ожидаемого эффекта в части модулей, потому что значения из `config` читались один раз при импорте модуля и кэшировались в `const`.

## Что было не так

В нескольких файлах использовались верхнеуровневые алиасы вида:

- `const CAP_W = config.walls.CAP_W`
- `const NOR_W = config.walls.NOR_W`
- `const UNITS_PER_M = config.units.UNITS_PER_M`
- и т.д.

После `config.override(...)` такие константы не обновлялись.

## Что изменено

### 1) `renderer/render.js`
- Убраны верхнеуровневые кэши:
  - `CAP_W`, `NOR_W`
  - `FURN_SVG_COLOR`, `FURN_SVG_HOVER_COLOR`, `FURN_SVG_SELECTED_COLOR`
  - `FURN_PREVIEW_OK_COLOR`, `FURN_PREVIEW_INVALID_COLOR`
- Везде заменено на прямое чтение из `config` в момент выполнения:
  - `config.walls.CAP_W`, `config.walls.NOR_W`
  - `config.theme.wall.*`, `config.theme.cursor.invalid` и т.д.

### 2) `planner/templates.js`
- Константа `studioWindows` заменена на функцию `getStudioWindows()`, чтобы значения (например `CAP_W`) брались динамически.
- `thick: CAP_W` заменено на `thick: config.walls.CAP_W`.
- Инициализация окон: `state.windows = getStudioWindows()`.

### 3) `planner/app.js`
- Импорт `studioWindows` заменен на `getStudioWindows`.
- Цикл инициализации окон переведен на `getStudioWindows()`.

### 4) `interaction/pointer.js`
- `MIN_WALL_LEN` заменен на функцию `minWallLen() => config.walls.MIN_LEN`.
- `DRAW_CLEAR` заменен на функцию `drawClear() => Math.max(0, CLEAR_FROM_CAPITAL() * (config.constraints?.drawClearMul ?? 0.1))`.
- Все проверки используют динамические вызовы `minWallLen()` / `drawClear()`.

### 5) `engine/units.js`
- Убран кэш `UNITS_PER_M`.
- Конвертеры читают `config.units.UNITS_PER_M` напрямую при вызове.

### 6) `engine/metrics.js`
- Убран кэш `UNITS_PER_M`.
- Пересчет площади в м² использует текущее `config.units.UNITS_PER_M`.

## Результат

`config.override(options.settings)` теперь влияет на поведение модулей после инициализации, потому что значения читаются из `config` в runtime, а не из старых кэшированных констант.

## Важный нюанс по ключам settings

`override` применяет только существующие ключи конфигурации.  
Пример: `walls.capital` невалиден и игнорируется; правильный путь для цвета капитальных стен — `theme.wall.capital`.

## Как проверить

1. В `Planner.init` передать:
   - `walls.CAP_W`
   - `walls.NOR_W`
   - `theme.wall.capital`
   - `units.UNITS_PER_M`
2. Перезапустить страницу.
3. Проверить:
   - толщины стен/элементов изменились;
   - цвета применились;
   - метрики (м/м²) соответствуют новому `UNITS_PER_M`.