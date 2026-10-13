// Agent Panel prototype: the model and mode menus, shared by every page.
// A page's composer sets data-engine, data-model-claude, data-model-cursor and data-mode;
// this fills in both menus and the picker labels to match.
// In the extension, the Cursor list comes from `agent --list-models` (cached) and the Claude list from the CLI aliases.

(function () {
  const MODELS = {
    claude: {
      label: 'Claude · your Claude plan',
      items: [
        ['fable', 'Fable', 'Most capable'],
        ['opus', 'Opus', ''],
        ['sonnet', 'Sonnet', 'Faster'],
        ['haiku', 'Haiku', 'Fastest'],
      ],
    },
    cursor: {
      label: 'Cursor · your Cursor plan',
      items: [
        ['auto', 'Auto', 'Cursor picks'],
        ['composer-2.5', 'Composer 2.5', ''],
        ['gpt-5.3-codex', 'GPT-5.3 Codex', ''],
        ['claude-sonnet-5-thinking-high', 'Sonnet 5 Thinking', ''],
        ['gemini-3.7-flash-high', 'Gemini 3.7 Flash', ''],
      ],
    },
  };

  const MODES = [
    ['agent', 'Agent', 'codicon-infinity', 'Edits files and runs commands'],
    ['plan', 'Plan', 'codicon-checklist', 'Reads only, then proposes a plan'],
    ['handoff', 'Hand-off', 'codicon-arrow-swap', 'One engine plans, the other builds'],
  ];

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  }

  document.querySelectorAll('.ap-composer').forEach((composer) => {
    const engine = composer.dataset.engine || 'claude';
    const mode = composer.dataset.mode || 'agent';
    const picked = {
      claude: composer.dataset.modelClaude || 'opus',
      cursor: composer.dataset.modelCursor || 'auto',
    };

    let modelHtml = '<div class="ap-menu" data-menu-id="model" role="menu" hidden>';
    Object.keys(MODELS).forEach((key) => {
      const g = MODELS[key];
      modelHtml += '<div data-group="' + key + '"' + (key === engine ? '' : ' hidden') + '>';
      modelHtml += '<div class="ap-menu__label">' + esc(g.label) + '</div>';
      g.items.forEach(([value, label, hint]) => {
        modelHtml +=
          '<button class="ap-menu__item" role="menuitemradio" data-value="' + esc(value) + '" data-label="' + esc(label) +
          '" aria-checked="' + (value === picked[key]) + '"><i class="codicon codicon-check"></i><span>' + esc(label) +
          '</span><span class="ap-menu__hint">' + esc(hint) + '</span></button>';
      });
      modelHtml += '</div>';
    });
    modelHtml += '</div>';

    let modeHtml = '<div class="ap-menu" data-menu-id="mode" role="menu" hidden>';
    MODES.forEach(([value, label, icon, desc]) => {
      modeHtml +=
        '<button class="ap-menu__item" role="menuitemradio" data-value="' + value + '" data-label="' + label +
        '" aria-checked="' + (value === mode) + '"><i class="codicon codicon-check"></i><span><i class="codicon ' + icon +
        '"></i> ' + label + '</span><span></span><span class="ap-menu__desc">' + esc(desc) + '</span></button>';
    });
    modeHtml += '</div>';

    composer.insertAdjacentHTML('beforeend', modelHtml + modeHtml);

    composer.querySelectorAll('.ap-seg button').forEach((b) => {
      b.setAttribute('aria-checked', String(b.dataset.engine === engine));
    });
    const modelLabel = composer.querySelector('[data-menu="model"] .ap-picker__label');
    const current = MODELS[engine].items.find((i) => i[0] === picked[engine]);
    if (modelLabel && current) modelLabel.textContent = current[1];
    const modeLabel = composer.querySelector('[data-menu="mode"] .ap-picker__label');
    const currentMode = MODES.find((m) => m[0] === mode);
    if (modeLabel && currentMode) modeLabel.textContent = currentMode[1];
    const row = composer.querySelector('.ap-handoff-row');
    if (row) row.hidden = mode !== 'handoff';
  });
})();
