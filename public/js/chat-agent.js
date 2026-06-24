(function () {
  'use strict';

  const STORAGE_KEY_HISTORY = 'bh-chat-history';

  let open = false;
  let messages = [];
  let sending = false;
  let online = true;

  function loadHistory() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_HISTORY);
      if (raw) messages = JSON.parse(raw).slice(-50);
    } catch (e) {
      messages = [];
    }
  }

  function saveHistory() {
    try {
      localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(messages.slice(-50)));
    } catch (e) {
      // ignore
    }
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'className') node.className = attrs[k];
        else if (k === 'innerHTML') node.innerHTML = attrs[k];
        else if (k.startsWith('on') && typeof attrs[k] === 'function') {
          node.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
        } else {
          node.setAttribute(k, attrs[k]);
        }
      });
    }
    if (children) {
      children.forEach(function (c) {
        if (typeof c === 'string') node.appendChild(document.createTextNode(c));
        else if (c) node.appendChild(c);
      });
    }
    return node;
  }

  function renderWidget() {
    const existing = document.getElementById('bh-chat-widget');
    if (existing) existing.remove();

    const container = el('div', { id: 'bh-chat-widget' });

    if (!open) {
      container.appendChild(
        el('button', {
          className: 'bh-chat-bubble',
          'aria-label': 'Open blotter.host assistant',
          onClick: function () {
            open = true;
            if (messages.length === 0) {
              messages.push({
                role: 'assistant',
                content: "Hi — I'm the blotter.host assistant. I can help you find a state page, search the network, or explain how the 50-state public records directory works. What can I help with?",
              });
              saveHistory();
            }
            renderWidget();
          },
        }, [
          el('svg', { width: '24', height: '24', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, [
            el('path', { d: 'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z' }),
          ]),
        ])
      );
    } else {
      const panel = el('div', {
        className: 'bh-chat-panel',
        role: 'dialog',
        'aria-label': 'blotter.host assistant',
      });

      const header = el('div', { className: 'bh-chat-header' }, [
        el('div', { className: 'bh-chat-header__title' }, [
          el('div', { className: 'bh-chat-header__avatar' }, ['BH']),
          el('div', {}, [
            el('div', { className: 'bh-chat-header__name' }, ['blotter.host assistant']),
            el('div', { className: 'bh-chat-header__status' }, [online ? 'Online' : 'Offline']),
          ]),
        ]),
        el('div', { className: 'bh-chat-header__actions' }, [
          el('button', {
            className: 'bh-chat-header__btn',
            'aria-label': 'Clear chat',
            title: 'Clear chat',
            onClick: clearChat,
          }, [
            el('svg', { width: '16', height: '16', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, [
              el('path', { d: 'M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' }),
            ]),
          ]),
          el('button', {
            className: 'bh-chat-header__btn',
            'aria-label': 'Close chat',
            onClick: function () { open = false; renderWidget(); },
          }, [
            el('svg', { width: '18', height: '18', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, [
              el('path', { d: 'M18 6L6 18M6 6l12 12' }),
            ]),
          ]),
        ]),
      ]);

      const messagesEl = el('div', { className: 'bh-chat-messages' });
      if (messages.length === 0) {
        messagesEl.appendChild(el('div', { className: 'bh-chat-empty' }, ['Ask about the blotter.host network, state pages, or how to subscribe.']));
      } else {
        messages.forEach(function (m) {
          messagesEl.appendChild(renderMessage(m));
        });
      }

      const input = el('textarea', {
        className: 'bh-chat-input',
        rows: '1',
        placeholder: 'Ask about the network...',
        maxLength: '2000',
      });

      const form = el('form', {
        className: 'bh-chat-form',
        onSubmit: function (e) {
          e.preventDefault();
          const text = input.value.trim();
          if (!text || sending || !online) return;
          input.value = '';
          sendMessage(text);
        },
      }, [
        input,
        el('button', {
          type: 'submit',
          className: 'bh-chat-send',
          'aria-label': 'Send message',
        }, [
          el('svg', { width: '16', height: '16', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, [
            el('path', { d: 'M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z' }),
          ]),
        ]),
      ]);

      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          form.dispatchEvent(new Event('submit'));
        }
      });

      panel.appendChild(header);
      panel.appendChild(messagesEl);
      panel.appendChild(form);
      container.appendChild(panel);

      setTimeout(function () {
        messagesEl.scrollTop = messagesEl.scrollHeight;
        input.focus();
      }, 0);
    }

    document.body.appendChild(container);
  }

  function renderMessage(m) {
    const isUser = m.role === 'user';
    return el('div', { className: 'bh-chat-msg ' + (isUser ? 'bh-chat-msg--user' : 'bh-chat-msg--assistant') }, [
      el('div', { className: 'bh-chat-msg__bubble' }, m.streaming && !m.content ? [
        el('span', { className: 'bh-chat-typing' }, [
          el('span', { className: 'bh-chat-typing__dot' }),
          el('span', { className: 'bh-chat-typing__dot' }),
          el('span', { className: 'bh-chat-typing__dot' }),
        ]),
      ] : [renderMarkdown(m.content)]),
    ]);
  }

  function renderMarkdown(text) {
    const wrapper = el('span', {});
    const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g);
    parts.forEach(function (part) {
      if (part.startsWith('**') && part.endsWith('**')) {
        wrapper.appendChild(el('strong', {}, [part.slice(2, -2)]));
      } else if (part.startsWith('*') && part.endsWith('*')) {
        wrapper.appendChild(el('em', {}, [part.slice(1, -1)]));
      } else if (part.startsWith('[') && part.includes('](')) {
        const match = part.match(/\[([^\]]+)\]\(([^)]+)\)/);
        if (match) {
          wrapper.appendChild(el('a', { href: match[2], target: '_blank', rel: 'noopener noreferrer' }, [match[1]]));
        } else {
          wrapper.appendChild(document.createTextNode(part));
        }
      } else {
        part.split('\n').forEach(function (line, i, arr) {
          wrapper.appendChild(document.createTextNode(line));
          if (i < arr.length - 1) wrapper.appendChild(el('br'));
        });
      }
    });
    return wrapper;
  }

  function clearChat() {
    messages = [];
    saveHistory();
    renderWidget();
  }

  function sendMessage(text) {
    messages.push({ role: 'user', content: text });
    const assistantId = 'a-' + Date.now();
    messages.push({ role: 'assistant', content: '', streaming: true, id: assistantId });
    sending = true;
    saveHistory();
    renderWidget();

    fetch('/api/chat/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: messages.filter(function (m) { return !m.streaming; }) }),
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let assembled = '';

        function read() {
          return reader.read().then(function (result) {
            if (result.done) {
              finalize(assistantId, assembled || 'Sorry, I could not generate a response.');
              return;
            }
            buf += decoder.decode(result.value, { stream: true });
            let idx;
            while ((idx = buf.indexOf('\n\n')) !== -1) {
              const block = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              const lines = block.split('\n');
              let data = '';
              lines.forEach(function (line) {
                if (line.startsWith('data: ')) data += line.slice(6);
              });
              if (!data || data === '[DONE]') continue;
              try {
                const parsed = JSON.parse(data);
                if (parsed.error) {
                  finalize(assistantId, 'Error: ' + parsed.error);
                  return;
                }
                if (parsed.text) {
                  assembled += parsed.text;
                  updateAssistant(assistantId, assembled);
                }
              } catch (e) {
                // ignore
              }
            }
            return read();
          });
        }
        return read();
      })
      .catch(function (err) {
        finalize(assistantId, 'Sorry, the connection failed. Please try again.');
        console.error('[bh-chat]', err);
      });
  }

  function updateAssistant(id, text) {
    messages = messages.map(function (m) {
      return m.id === id ? { ...m, content: text, streaming: true } : m;
    });
    saveHistory();
    renderWidget();
  }

  function finalize(id, text) {
    messages = messages.map(function (m) {
      return m.id === id ? { role: 'assistant', content: text, streaming: false } : m;
    });
    sending = false;
    saveHistory();
    renderWidget();
  }

  function injectStyles() {
    if (document.getElementById('bh-chat-styles')) return;
    const css = `
      #bh-chat-widget { font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
      .bh-chat-bubble { position: fixed; bottom: 1rem; right: 1rem; z-index: 9999; width: 56px; height: 56px; border-radius: 50%; border: none; background: #1f2933; color: #fff; display: flex; align-items: center; justify-content: center; box-shadow: 0 8px 24px rgba(0,0,0,0.25); cursor: pointer; transition: transform 0.15s, background 0.15s; }
      .bh-chat-bubble:hover { background: #2f3d4d; transform: scale(1.05); }
      .bh-chat-panel { position: fixed; bottom: 1rem; right: 1rem; z-index: 9999; width: min(380px, calc(100vw - 2rem)); height: min(560px, 80vh); background: #fff; border-radius: 12px; box-shadow: 0 16px 48px rgba(0,0,0,0.2); display: flex; flex-direction: column; overflow: hidden; border: 1px solid #e2e8f0; }
      .bh-chat-header { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; background: #1f2933; color: #fff; }
      .bh-chat-header__title { display: flex; align-items: center; gap: 10px; }
      .bh-chat-header__avatar { width: 32px; height: 32px; border-radius: 50%; background: rgba(255,255,255,0.15); display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; }
      .bh-chat-header__name { font-size: 14px; font-weight: 600; }
      .bh-chat-header__status { font-size: 11px; opacity: 0.75; }
      .bh-chat-header__actions { display: flex; gap: 4px; }
      .bh-chat-header__btn { background: transparent; border: none; color: rgba(255,255,255,0.8); padding: 6px; border-radius: 6px; cursor: pointer; display: flex; }
      .bh-chat-header__btn:hover { background: rgba(255,255,255,0.1); color: #fff; }
      .bh-chat-messages { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; background: #f8fafc; }
      .bh-chat-empty { text-align: center; color: #64748b; font-size: 13px; padding: 24px 0; }
      .bh-chat-msg { display: flex; }
      .bh-chat-msg--user { justify-content: flex-end; }
      .bh-chat-msg--assistant { justify-content: flex-start; }
      .bh-chat-msg__bubble { max-width: 80%; padding: 10px 14px; border-radius: 18px; font-size: 13px; line-height: 1.5; word-wrap: break-word; }
      .bh-chat-msg--user .bh-chat-msg__bubble { background: #1f2933; color: #fff; border-bottom-right-radius: 4px; }
      .bh-chat-msg--assistant .bh-chat-msg__bubble { background: #fff; color: #1f2933; border: 1px solid #e2e8f0; border-bottom-left-radius: 4px; }
      .bh-chat-msg__bubble a { text-decoration: underline; color: inherit; }
      .bh-chat-typing { display: inline-flex; gap: 4px; align-items: center; height: 16px; }
      .bh-chat-typing__dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; opacity: 0.6; animation: bh-chat-bounce 1.2s infinite ease-in-out; }
      .bh-chat-typing__dot:nth-child(2) { animation-delay: 0.15s; }
      .bh-chat-typing__dot:nth-child(3) { animation-delay: 0.3s; }
      @keyframes bh-chat-bounce { 0%, 80%, 100% { transform: translateY(0); } 40% { transform: translateY(-4px); } }
      .bh-chat-form { display: flex; gap: 8px; padding: 12px; border-top: 1px solid #e2e8f0; background: #fff; }
      .bh-chat-input { flex: 1; resize: none; border: 1px solid #cbd5e1; border-radius: 20px; padding: 10px 14px; font-size: 13px; font-family: inherit; outline: none; min-height: 40px; max-height: 120px; }
      .bh-chat-input:focus { border-color: #1f2933; }
      .bh-chat-send { width: 40px; height: 40px; border-radius: 50%; border: none; background: #1f2933; color: #fff; display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; }
      .bh-chat-send:hover { background: #2f3d4d; }
      .bh-chat-send:disabled { opacity: 0.5; cursor: not-allowed; }
    `;
    const style = el('style', { id: 'bh-chat-styles' }, [css]);
    document.head.appendChild(style);
  }

  function init() {
    injectStyles();
    fetch('/api/chat/', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) { online = Boolean(data.online); renderWidget(); })
      .catch(function () { online = false; renderWidget(); });

    loadHistory();
    renderWidget();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
