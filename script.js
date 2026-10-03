const form = document.querySelector("#rsvp-form");
    const formMessage = document.querySelector("#form-message");
const apiBase = window.WEDDING_API_URL;
const guestQuestionnaire = document.querySelector("#guest-questionnaire");
const companionsRow = document.querySelector("#companions-row");
const companionCount = document.querySelector("#companion-count");
const companionList = document.querySelector("#companion-list");
const alcoholOtherToggle = document.querySelector("#alcohol-other-toggle");
const alcoholOtherRow = document.querySelector("#alcohol-other-row");
const alcoholOtherField = document.querySelector("#alcohol-other");
const submittedMessage = "Спасибо! Ваши ответы отправлены организаторам.";
const submittedStorageKey = "wedding-rsvp-submitted-v1";
const submittedCookieName = "wedding-rsvp-submitted";

const revealTargets = document.querySelectorAll(
  ".welcome, .location-layout, .schedule-list, .dresscode, .details, .rsvp-intro, .rsvp-form, .footer"
);

if ("IntersectionObserver" in window && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  const revealObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("is-visible");
      observer.unobserve(entry.target);
    });
  }, { threshold: 0.12, rootMargin: "0px 0px -5% 0px" });

  revealTargets.forEach((target) => {
    target.classList.add("scroll-reveal");
    revealObserver.observe(target);
  });
}

const lockForm = () => {
  form.querySelectorAll("input, select, textarea, button").forEach((control) => {
    control.disabled = true;
  });
  formMessage.textContent = submittedMessage;
};

const hasSubmitted = () => {
  try {
    if (localStorage.getItem(submittedStorageKey) === "true") return true;
  } catch {
    // Проверяем cookie, если хранилище браузера недоступно.
  }
  return document.cookie.split(";").some((cookie) => cookie.trim() === `${submittedCookieName}=true`);
};

const saveSubmitted = () => {
  try {
    localStorage.setItem(submittedStorageKey, "true");
  } catch {
    // Cookie ниже сохраняет отметку, если хранилище браузера недоступно.
  }
  document.cookie = `${submittedCookieName}=true; Max-Age=31536000; Path=/; Domain=konstantin-anastasiya.ru; SameSite=Lax`;
};

try {
  if (hasSubmitted()) {
    saveSubmitted();
    lockForm();
  }
} catch {
  // Если хранилище браузера недоступно, форма остаётся доступной.
}

const updateCompanionFields = () => {
  const count = Number(companionCount.value);
  const existingFields = [...companionList.querySelectorAll(".companion-entry")];
  companionList.replaceChildren();
  companionList.hidden = count === 0;

  for (let index = 0; index < count; index += 1) {
    const entry = document.createElement("div");
    const nameLabel = document.createElement("label");
    const nameCaption = document.createElement("span");
    const nameInput = document.createElement("input");
    const typeLabel = document.createElement("label");
    const typeCaption = document.createElement("span");
    const typeSelect = document.createElement("select");

    entry.className = "companion-entry";
    nameCaption.className = "microcopy";
    nameCaption.textContent = `Гость ${index + 1} — имя и фамилия`;
    nameInput.className = "field-input";
    nameInput.name = "companionNames[]";
    nameInput.autocomplete = "off";
    nameInput.required = true;
    nameInput.value = existingFields[index]?.querySelector(".field-input")?.value || "";
    nameLabel.append(nameCaption, nameInput);

    typeCaption.className = "microcopy";
    typeCaption.textContent = "Кто придёт?";
    typeSelect.className = "field-select";
    typeSelect.name = "companionTypes[]";
    typeSelect.add(new Option("Взрослый", "adult"));
    typeSelect.add(new Option("Ребёнок", "child"));
    typeSelect.value = existingFields[index]?.querySelector(".field-select")?.value || "adult";
    typeLabel.append(typeCaption, typeSelect);

    entry.append(nameLabel, typeLabel);
    companionList.append(entry);
  }
};

form.addEventListener("change", (event) => {
  if (event.target.name === "attendance") {
    const attending = event.target.value === "yes";
    guestQuestionnaire.hidden = !attending;
    guestQuestionnaire.disabled = !attending;
    companionsRow.hidden = !attending;
    if (!attending) companionCount.value = "0";
    updateCompanionFields();
  }

  if (event.target === companionCount) updateCompanionFields();

  if (event.target === alcoholOtherToggle) {
    alcoholOtherRow.hidden = !alcoholOtherToggle.checked;
    alcoholOtherField.required = alcoholOtherToggle.checked;
    if (!alcoholOtherToggle.checked) alcoholOtherField.value = "";
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;

  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  formMessage.textContent = "Отправляем ответы…";

  const values = new FormData(form);
  const payload = Object.fromEntries(values.entries());
  payload.alcohol = values.getAll("alcohol");
  payload.companionNames = values.getAll("companionNames[]");
  payload.companionTypes = values.getAll("companionTypes[]");

  try {
    const response = await fetch(`${apiBase}/api/rsvp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error("Не удалось отправить ответы.");
    saveSubmitted();
    lockForm();
  } catch {
    button.disabled = false;
    formMessage.textContent = "Не получилось отправить анкету. Проверьте интернет и попробуйте ещё раз.";
  }
});
