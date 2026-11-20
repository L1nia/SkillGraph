# SkillGraph MCP

Для полуавтономного выполнения агентных цепочек после подключения MCP активируйте
worker-режим по инструкции [WORKER-MODE.md](WORKER-MODE.md). Сам факт открытого
Cursor не означает, что очередь выполняется: активный Cursor Agent должен один
раз зарегистрировать runtime-сессию и начать цикл получения задач.

SkillGraph 0.8 предоставляет локальный read/write MCP-сервер. Он не копирует Markdown-скиллы в репозиторий и не загружает `skill://`-ссылки из интернета.

## Поток контекста

1. AI вызывает `resolve_task_context` с абсолютным путём рабочей области и текущей задачей.
2. Сервер сопоставляет путь с проектом из реестра SkillGraph.
3. Корневые скиллы разворачиваются в dependency-first цепочку.
4. Ответ содержит `requiredOrder`, узлы, рёбра, конфликты, полный Markdown и манифест `attachments` для каждого скилла.
5. Для отдельной ссылки агент вызывает `read_skill` либо `resources/read`.
6. Если у скилла есть изображения, агент вызывает `read_skill_asset` с `reference` и `assetId`. Инструмент возвращает MCP `ImageContent`, поэтому Cursor/Codex видит пиксели, а не только строку `skillgraph-asset://...`.

Изображения загружаются лениво: base64 не добавляется в каждый контекст. В контексте
передаются подпись, MIME-тип, идентификатор и готовые аргументы вызова. Сам файл
читается только по запросу агента; размер одного вложения ограничен 20 МБ.

Реестр читается заново при каждом запросе. Операционные события маршрутизации,
разрешения контекста, handoff и результата автоматически дописываются в локальный
`auditLog`; скиллы, проекты и исходный код при этом не изменяются.

## Провайдер и фактическое выполнение

Поле `agent.provider` задаёт runtime, которому разрешено исполнять профиль агента,
а не просто подпись в интерфейсе. Каждая глобальная MCP-конфигурация передаёт
`--client-provider cursor`, `codex`, `claude`, `copilot`, `local` или `custom`.

- Task Manager работает через провайдер, выбранный в его профиле; Cursor Task
  Manager планирует через Cursor, Claude Task Manager — через Claude и так далее.
- один провайдер не может вызвать `resolve_agent_context` или
  `record_agent_outcome` за агента, назначенного другому провайдеру;
- каждый runtime видит предназначенные ему передачи через `list_agent_handoffs`.
- первый `resolve_agent_context` целевого Cursor-агента автоматически переводит
  handoff из `pending` в `accepted`;
- `record_agent_outcome` автоматически переводит принятый handoff в `done`.

SkillGraph не запускает окно Cursor и не создаёт в нём чат: MCP — это подключение
Cursor к очереди и контексту SkillGraph. Фактическое выполнение происходит только
когда запрос сделан самим Cursor через его MCP-подключение.

## Глобальная конфигурация Cursor

Кнопка «Подключить Cursor» безопасно объединяет существующий `~/.cursor/mcp.json` со следующей записью:

```json
{
  "mcpServers": {
    "skillgraph": {
      "type": "stdio",
      "command": "C:\\path\\to\\SkillGraph.Mcp.exe",
      "args": [
        "--registry",
        "C:\\Users\\user\\AppData\\Local\\SkillGraph\\registry.json",
        "--client-provider",
        "cursor"
      ]
    }
  }
}
```

Другие записи `mcpServers` сохраняются.

## Инструкция агенту

Сервер передаёт эту инструкцию во время MCP-инициализации:

> Before planning or changing code, call resolve_task_context with the current workspace path and the user's task. Read skills in requiredOrder. Respect provider affinity: route and hand off cross-provider work, but resolve and execute only agents assigned to this client provider. Resolve skill:// references through this server; never download them from the web.

## Протокол

- транспорт: newline-delimited JSON-RPC 2.0 через `stdio`;
- совместимый handshake: MCP `2025-11-25` и более ранние версии;
- поддержаны tools, resources, resource templates и prompts;
- сервер не пишет диагностические сообщения в stdout.
