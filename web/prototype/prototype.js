/* Pi Agent UI prototype — minimal interactions only. */
(function () {
  const device = document.getElementById("device");
  const app = device.querySelector(".app");
  const messages = document.getElementById("messages");
  const messageCol = messages.querySelector(".message-col");
  const input = document.getElementById("composer-input");
  const sendBtn = document.getElementById("send");
  const approval = document.getElementById("approval");

  function setPressed(selector, current) {
    document.querySelectorAll(selector).forEach((btn) => {
      btn.setAttribute("aria-pressed", String(btn === current));
    });
  }

  /* ---------- Prototype controls ---------- */
  document.querySelectorAll("[data-theme-btn]").forEach((btn) => {
    btn.addEventListener("click", () => {
      device.dataset.theme = btn.dataset.themeBtn;
      setPressed("[data-theme-btn]", btn);
    });
  });

  document.querySelectorAll("[data-width-btn]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const value = btn.dataset.widthBtn;
      device.style.width = value === "100%" ? "100%" : value + "px";
      device.style.maxWidth = value === "100%" ? "1100px" : "100%";
      setPressed("[data-width-btn]", btn);
    });
  });

  function showPage(name) {
    const view = name === "empty" ? "empty" : name;
    document.querySelectorAll(".view").forEach((el) => {
      el.classList.toggle("active", el.dataset.view === view);
    });
    const tabName = name === "sessions" || name === "manage" ? name : "chat";
    document.querySelectorAll("[data-tab]").forEach((tab) => {
      const active = tab.dataset.tab === tabName;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    const pageBtn = document.querySelector('[data-page-btn="' + name + '"]');
    if (pageBtn) setPressed("[data-page-btn]", pageBtn);
  }

  document.querySelectorAll("[data-page-btn]").forEach((btn) => {
    btn.addEventListener("click", () => showPage(btn.dataset.pageBtn));
  });

  document.querySelectorAll("[data-tab]").forEach((tab) => {
    tab.addEventListener("click", () => showPage(tab.dataset.tab));
  });

  /* ---------- Collapsible thinking / tool cards ---------- */
  document.querySelectorAll("[data-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const card = btn.closest(".thinking, .tool");
      if (!card) return;
      const open = card.classList.toggle("open");
      btn.setAttribute("aria-expanded", String(open));
    });
  });

  /* ---------- Picker menus ---------- */
  function closeMenus(except) {
    document.querySelectorAll(".menu-wrap.open").forEach((wrap) => {
      if (wrap === except) return;
      wrap.classList.remove("open");
      const btn = wrap.querySelector("[data-menu-btn]");
      if (btn) btn.setAttribute("aria-expanded", "false");
    });
  }

  document.querySelectorAll("[data-menu-btn]").forEach((btn) => {
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      const wrap = btn.closest(".menu-wrap");
      const willOpen = !wrap.classList.contains("open");
      closeMenus(wrap);
      wrap.classList.toggle("open", willOpen);
      btn.setAttribute("aria-expanded", String(willOpen));
      if (willOpen) {
        const search = wrap.querySelector(".menu-search");
        if (search) {
          search.value = "";
          wrap.querySelectorAll(".menu-item").forEach((item) => {
            item.style.display = "";
          });
          search.focus();
        }
      }
    });
  });

  document.querySelectorAll("[data-option]").forEach((option) => {
    option.addEventListener("click", () => {
      const wrap = option.closest(".menu-wrap");
      const label = wrap.querySelector("[data-menu-label]");
      if (label) label.textContent = option.dataset.label;
      wrap.querySelectorAll("[data-option]").forEach((item) => {
        const selected = item === option;
        item.classList.toggle("selected", selected);
        item.setAttribute("aria-selected", String(selected));
      });
      closeMenus();
      wrap.querySelector("[data-menu-btn]").focus();
    });
  });

  document.querySelectorAll(".menu-search").forEach((search) => {
    search.addEventListener("input", () => {
      const q = search.value.trim().toLowerCase();
      search.closest(".menu").querySelectorAll(".menu-item").forEach((item) => {
        item.style.display = item.textContent.toLowerCase().includes(q) ? "" : "none";
      });
    });
  });

  document.querySelectorAll(".menu").forEach((menu) => {
    menu.addEventListener("click", (event) => event.stopPropagation());
  });

  document.querySelectorAll(".subtab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".subtab").forEach((t) => t.classList.toggle("active", t === tab));
    });
  });

  document.querySelectorAll(".session-card").forEach((card) => {
    card.addEventListener("click", (event) => {
      if (event.target.closest("button")) return;
      showPage("chat");
    });
  });

  document.addEventListener("click", () => closeMenus());

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeMenus();
      if (document.activeElement === input) input.blur();
    }
  });

  /* ---------- Switches ---------- */
  document.querySelectorAll(".switch").forEach((sw) => {
    sw.setAttribute("role", "switch");
    sw.setAttribute("aria-checked", String(sw.classList.contains("on")));
    sw.addEventListener("click", () => {
      const on = sw.classList.toggle("on");
      sw.setAttribute("aria-checked", String(on));
    });
  });

  /* ---------- Send ---------- */
  function addSystem(text) {
    const chip = document.createElement("div");
    chip.className = "system";
    chip.innerHTML = '<svg class="ic ic-sm"><use href="#i-info"></use></svg><span></span>';
    chip.querySelector("span").textContent = text;
    messageCol.appendChild(chip);
    messages.scrollTop = messages.scrollHeight;
  }

  function addUser(text) {
    const wrap = document.createElement("div");
    wrap.className = "msg msg-user";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = text;
    wrap.appendChild(bubble);
    messageCol.appendChild(wrap);
  }

  function addAssistantReply() {
    const article = document.createElement("article");
    article.className = "msg msg-assistant";
    article.innerHTML =
      '<div class="msg-head"><span class="avatar">π</span><span class="who">Pi</span><span class="when">now</span></div>' +
      '<div class="msg-body"><p class="muted">Thinking…</p></div>';
    messageCol.appendChild(article);
    messages.scrollTop = messages.scrollHeight;

    window.setTimeout(() => {
      article.querySelector(".msg-body").innerHTML =
        "<p>收到。这是原型的发送演示——真实版本会在这里流式渲染 pi 的回复。</p>" +
        "<p>重点看布局：消息列有最大阅读宽度，窄窗口自动收边距，底部工具行在 360px 时只保留图标。</p>";
      messages.scrollTop = messages.scrollHeight;
    }, 700);
  }

  function send() {
    const text = input.value.trim();
    if (!text) return;
    addUser(text);
    input.value = "";
    input.style.height = "auto";
    input.focus();
    addAssistantReply();
  }

  sendBtn.addEventListener("click", send);

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });

  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 140) + "px";
  });

  /* ---------- Approval ---------- */
  if (approval) {
    approval.querySelectorAll("[data-approve]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const allowed = btn.dataset.approve === "allow";
        approval.classList.add("resolved");
        window.setTimeout(() => {
          approval.remove();
          addSystem((allowed ? "Allowed" : "Denied") + " · npm run build");
        }, 150);
      });
    });
  }
})();
