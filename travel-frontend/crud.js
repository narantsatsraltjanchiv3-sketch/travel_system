/*
  Нэгдсэн CRUD функц — Аялал, Захиалга, Үйлчлүүлэгч, Хөтөч зэрэг цэс бүрт дахин ашиглана.

  Заавал:
    endpoint      серверийн хаяг, жишээ нь "/tours"
    idKey         мөр бүрийн ID талбар, жишээ нь "tour_id"
    itemName      мессежүүдэд гарах нэр, жишээ нь "аялал"
    columns       хүснэгтийн баганууд: [{ key, label, render(row) }]
    fields        нэмэх/засах цонхны талбарууд:
                  [{ key, label, type, required, min, step, numeric, default, options() }]
    deleteLabel   (row) => "устгах уу?" цонхонд гарах нэр

  Сонголтоор:
    searchKeys    хайлт хийх талбарууд
    subtitle      хүснэгтийн дээрх тайлбар, жишээ нь "Сүүлийн 50 захиалга"
    filter        серверт ?param=утга гэж илгээх шүүлтүүр:
                  { param, label, options: [{ value, label }] }
    rowActions    мөр бүрт нэмэлт товч:
                  [{ label, className, show(row), confirm: { title, text(row), button }, run(row) → шинэ мөр }]
    deleteFallback  устгаж чадахгүй үед санал болгох өөр үйлдэл:
                  { label, show(row), run(row) → шинэ мөр }
*/
function createCrudPage(config) {
  let items = [];
  let container = null;
  let searchText = "";
  let filterValue = "";

  // ---------- Хуудас зурах ----------
  async function render(target) {
    container = target;
    searchText = "";
    filterValue = "";

    const filterHtml = config.filter ? `
      <select class="filter" aria-label="${escapeHtml(config.filter.label)}">
        <option value="">${escapeHtml(config.filter.label)}: бүгд</option>
        ${config.filter.options.map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join("")}
      </select>` : "";

    const searchHtml = config.searchKeys ? '<input type="search" class="search" placeholder="Хайх...">' : "";

    container.innerHTML = `
      <div class="toolbar">
        ${searchHtml}
        ${filterHtml}
        <button type="button" class="btn btn-primary" data-action="add">+ Нэмэх</button>
      </div>
      <div class="panel"><div class="table-area"><p class="muted">Ачаалж байна...</p></div></div>`;

    const search = container.querySelector(".search");
    if (search) {
      search.addEventListener("input", () => {
        searchText = search.value.trim().toLowerCase();
        drawTable();
      });
    }

    const filter = container.querySelector(".filter");
    if (filter) {
      filter.addEventListener("change", () => {
        filterValue = filter.value;
        loadItems();
      });
    }

    container.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      const action = button.dataset.action;
      if (action === "add") return openForm(null);

      const row = items.find((item) => String(item[config.idKey]) === button.dataset.id);
      if (!row) return;
      if (action === "edit") openForm(row);
      else if (action === "delete") confirmDelete(row);
      else if (action.startsWith("custom-")) runRowAction(config.rowActions[Number(action.slice(7))], row);
    });

    await loadItems();
  }

  async function loadItems() {
    const area = container.querySelector(".table-area");
    area.innerHTML = '<p class="muted">Ачаалж байна...</p>';
    const query = config.filter && filterValue
      ? `?${config.filter.param}=${encodeURIComponent(filterValue)}`
      : "";
    try {
      items = await apiRequest(config.endpoint + query);
      drawTable();
    } catch (error) {
      area.innerHTML = `<p class="error-text">${escapeHtml(error.message)}</p>`;
    }
  }

  function filteredItems() {
    if (!searchText || !config.searchKeys) return items;
    return items.filter((item) =>
      config.searchKeys.some((key) => String(item[key] ?? "").toLowerCase().includes(searchText))
    );
  }

  function drawTable(highlightId) {
    const area = container.querySelector(".table-area");
    const rows = filteredItems();

    if (rows.length === 0) {
      area.innerHTML = `<p class="muted">${searchText || filterValue ? "Тохирох зүйл олдсонгүй." : "Одоогоор мэдээлэл алга."}</p>`;
      return;
    }

    const head = config.columns.map((c) => `<th>${c.label}</th>`).join("") + "<th></th>";
    const body = rows.map((row) => {
      const id = row[config.idKey];
      const cells = config.columns.map((c) =>
        `<td>${c.render ? c.render(row) : escapeHtml(row[c.key])}</td>`
      ).join("");

      const customButtons = (config.rowActions || []).map((a, i) =>
        !a.show || a.show(row)
          ? `<button type="button" class="btn btn-small ${a.className || ""}" data-action="custom-${i}" data-id="${id}">${a.label}</button>`
          : ""
      ).join("");

      return `
        <tr${id === highlightId ? ' class="highlight"' : ""}>
          ${cells}
          <td class="actions">
            ${customButtons}
            <button type="button" class="btn btn-small" data-action="edit" data-id="${id}">Засах</button>
            <button type="button" class="btn btn-small btn-danger" data-action="delete" data-id="${id}">Устгах</button>
          </td>
        </tr>`;
    }).join("");

    const subtitle = config.subtitle ? `${config.subtitle} · ` : "";
    area.innerHTML = `
      <p class="count muted">${subtitle}Харагдаж буй: ${rows.length}</p>
      <table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  }

  // Нэг мөрийг шинэчлээд хүснэгтийг дахин зурна
  function replaceItem(updated) {
    const id = updated[config.idKey];
    items = items.map((item) => (item[config.idKey] === id ? updated : item));
    drawTable(id);
  }

  // ---------- Нэмэлт товч (жишээ нь Батлах / Цуцлах) ----------
  async function runRowAction(action, row) {
    const execute = async () => {
      replaceItem(await action.run(row));
      showToast(action.done || "Амжилттай");
    };

    if (!action.confirm) {
      try {
        await execute();
      } catch (error) {
        showToast(error.message, true);
      }
      return;
    }

    openConfirm({
      title: action.confirm.title,
      text: action.confirm.text(row),
      button: action.confirm.button,
      danger: true,
      onConfirm: execute,
    });
  }

  // ---------- Нэмэх / Засах цонх ----------
  async function openForm(row) {
    const isEdit = Boolean(row);

    let fieldsHtml;
    try {
      fieldsHtml = await Promise.all(config.fields.map((f) => fieldHtml(f, row)));
    } catch (error) {
      showToast(error.message, true);
      return;
    }

    const dialog = createDialog(`
      <form class="modal-form">
        <h2>${isEdit ? "Засах" : "Шинэ " + config.itemName + " нэмэх"}</h2>
        ${fieldsHtml.join("")}
        <p class="form-error error-text" role="alert"></p>
        <div class="modal-buttons">
          <button type="button" class="btn" data-close>Болих</button>
          <button type="submit" class="btn btn-primary">${isEdit ? "Хадгалах" : "Нэмэх"}</button>
        </div>
      </form>`);

    const form = dialog.querySelector("form");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const errorEl = dialog.querySelector(".form-error");
      const submitBtn = form.querySelector('button[type="submit"]');
      errorEl.textContent = "";
      submitBtn.disabled = true;

      try {
        const data = readForm(form);
        if (isEdit) {
          const id = row[config.idKey];
          replaceItem(await apiRequest(`${config.endpoint}/${id}`, { method: "PUT", body: data }));
          showToast(`${capitalize(config.itemName)} шинэчлэгдлээ`);
        } else {
          const created = await apiRequest(config.endpoint, { method: "POST", body: data });
          items.unshift(created); // Шинээр нэмсэн нь хамгийн дээр
          drawTable(created[config.idKey]);
          showToast(`Шинэ ${config.itemName} нэмэгдлээ`);
        }
        dialog.close();
      } catch (error) {
        errorEl.textContent = error.message;
      } finally {
        submitBtn.disabled = false;
      }
    });

    dialog.showModal();
  }

  async function fieldHtml(f, row) {
    const value = row ? row[f.key] ?? "" : f.default ?? "";
    const required = f.required ? "required" : "";
    let input;

    if (f.type === "select") {
      const options = f.options ? await f.options() : [];
      const empty = f.required ? '<option value="">— Сонгоно уу —</option>' : '<option value="">— Сонгоогүй —</option>';
      input = `<select name="${f.key}" ${required}>
        ${empty}
        ${options.map((o) =>
          `<option value="${escapeHtml(o.value)}"${String(o.value) === String(value) ? " selected" : ""}>${escapeHtml(o.label)}</option>`
        ).join("")}
      </select>`;
    } else {
      const extra = [
        f.min !== undefined ? `min="${f.min}"` : "",
        f.step !== undefined ? `step="${f.step}"` : "",
        f.maxlength ? `maxlength="${f.maxlength}"` : "",
      ].join(" ");
      input = `<input type="${f.type || "text"}" name="${f.key}" value="${escapeHtml(value)}" ${required} ${extra}>`;
    }

    return `<label>${f.label}${f.required ? " *" : ""}</label>${input}`;
  }

  // Хоосон талбарыг null, тоог number болгоно
  function readForm(form) {
    const data = {};
    for (const f of config.fields) {
      const raw = form.elements[f.key].value.trim();
      if (raw === "") data[f.key] = null;
      else if (f.type === "number" || f.numeric) data[f.key] = Number(raw);
      else data[f.key] = raw;
    }
    return data;
  }

  // ---------- Устгах ----------
  function confirmDelete(row) {
    const fallback = config.deleteFallback;
    openConfirm({
      title: "Устгах уу?",
      text: `<strong>«${escapeHtml(config.deleteLabel(row))}»</strong> — энэ ${config.itemName} бүр мөсөн устгагдана. Буцаах боломжгүй.`,
      button: "Тийм, устгах",
      danger: true,
      onConfirm: async () => {
        const id = row[config.idKey];
        await apiRequest(`${config.endpoint}/${id}`, { method: "DELETE" });
        items = items.filter((item) => item[config.idKey] !== id);
        drawTable();
        showToast(`${capitalize(config.itemName)} устгагдлаа`);
      },
      // Устгаж чадаагүй үед (жишээ нь төлбөртэй захиалга) өөр үйлдэл санал болгоно
      fallback: fallback && (!fallback.show || fallback.show(row)) ? {
        label: fallback.label,
        run: async () => {
          replaceItem(await fallback.run(row));
          showToast(fallback.done || "Амжилттай");
        },
      } : null,
    });
  }

  return { render, reload: loadItems };
}

// ---------- Баталгаажуулах цонх (бүх хуудсанд ашиглана) ----------
function openConfirm({ title, text, button, danger, onConfirm, fallback }) {
  const dialog = createDialog(`
    <div class="modal-form">
      <h2>${escapeHtml(title)}</h2>
      <p>${text}</p>
      <p class="form-error error-text" role="alert"></p>
      <div class="modal-buttons">
        <button type="button" class="btn" data-close>Болих</button>
        <button type="button" class="btn ${danger ? "btn-danger" : "btn-primary"}" data-confirm>${escapeHtml(button)}</button>
      </div>
    </div>`);

  const errorEl = dialog.querySelector(".form-error");
  const closeBtn = dialog.querySelector("[data-close]");
  const confirmBtn = dialog.querySelector("[data-confirm]");

  confirmBtn.addEventListener("click", async () => {
    confirmBtn.disabled = true;
    try {
      await onConfirm();
      dialog.close();
    } catch (error) {
      errorEl.textContent = error.message;
      closeBtn.textContent = "Ойлголоо";

      if (fallback) {
        // "Устгах" товчийг санал болгосон үйлдлээр сольно
        confirmBtn.textContent = fallback.label;
        confirmBtn.disabled = false;
        const runFallback = async () => {
          confirmBtn.disabled = true;
          try {
            await fallback.run();
            dialog.close();
          } catch (err) {
            errorEl.textContent = err.message;
            confirmBtn.hidden = true;
          }
        };
        confirmBtn.replaceWith(confirmBtn.cloneNode(true));
        dialog.querySelector("[data-confirm]").addEventListener("click", runFallback);
      } else {
        confirmBtn.hidden = true;
      }
    }
  });

  dialog.showModal();
  return dialog;
}

function createDialog(innerHtml) {
  const dialog = document.createElement("dialog");
  dialog.className = "modal";
  dialog.innerHTML = innerHtml;
  document.body.appendChild(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  dialog.querySelector("[data-close]").addEventListener("click", () => dialog.close());
  return dialog;
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Баруун доод буланд богино мэдэгдэл гаргана
function showToast(text, isError = false) {
  const toast = document.createElement("div");
  toast.className = isError ? "toast toast-error" : "toast";
  toast.textContent = text;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), isError ? 4000 : 2500);
}
