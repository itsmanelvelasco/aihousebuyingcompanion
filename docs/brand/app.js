const details = {
  calaf: ["Calaf", "Primaria en el ejemplo. Plazas por confirmar con el centro.", "Estación en el ejemplo. Confirma horarios para tu jornada."],
  juncosa: ["Juncosa", "Confirma la etapa escolar y las plazas con el centro.", "Consulta las conexiones y la frecuencia para tu horario."],
  ulldemolins: ["Ulldemolins", "Confirma la disponibilidad de plazas con el centro.", "Comprueba el trayecto completo y sus transbordos."],
};

const towns = document.querySelector("#towns");
const cards = [...towns.querySelectorAll("[data-town]")];
const townButtons = [...towns.querySelectorAll("[data-town-button]")];
const filters = [...document.querySelectorAll("[data-filter]")];
const states = [...document.querySelectorAll("[data-state]")];
const statePanel = document.querySelector("#state");
const readout = document.querySelector("#readout");
const detail = document.querySelector("[aria-labelledby=detail-name]");
let filter = "all";
let selected = "calaf";

function selectTown(key) {
  selected = key;
  const [name, school, train] = details[key];
  document.querySelector("#detail-name").textContent = name;
  document.querySelector("#school-detail").textContent = school;
  document.querySelector("#train-detail").textContent = train;
  townButtons.forEach(button => button.setAttribute("aria-pressed", button.dataset.townButton === key));
  readout.textContent = "Ficha seleccionada: " + name + ".";
}

function showResults() {
  cards.forEach(card => { card.hidden = filter === "rail" && card.dataset.rail !== "true"; });
  const visible = cards.filter(card => !card.hidden);
  if (!visible.some(card => card.dataset.town === selected)) selectTown(visible[0].dataset.town);
  readout.textContent = visible.length === 1 ? "1 municipio en el ejemplo." : visible.length + " municipios en el ejemplo.";
}

function changeState(state) {
  states.forEach(button => button.setAttribute("aria-pressed", button.dataset.state === state));
  const hasResults = state === "results";
  filters.forEach(button => { button.disabled = !hasResults; });
  towns.hidden = !hasResults;
  detail.hidden = !hasResults;
  statePanel.hidden = hasResults;
  statePanel.classList.toggle("error", state === "error");
  if (hasResults) {
    showResults();
    return;
  }
  const messages = {
    loading: ["Cargando municipios", "Estamos preparando la comparación.", ""],
    empty: ["Sin coincidencias", "Prueba a revisar tus requisitos o ampliar la zona.", "Volver a resultados"],
    error: ["No se pudo cargar la lista", "Inténtalo de nuevo para recuperar los resultados.", "Reintentar"],
  };
  const [heading, message, action] = messages[state];
  const title = document.createElement("h3");
  title.textContent = heading;
  const paragraph = document.createElement("p");
  paragraph.textContent = message;
  statePanel.replaceChildren(title, paragraph);
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button alt";
    button.textContent = action;
    button.addEventListener("click", () => {
      changeState("results");
      filters.find(item => item.dataset.filter === filter).focus();
    });
    statePanel.append(button);
  }
  readout.textContent = heading + ".";
}

townButtons.forEach(button => button.addEventListener("click", () => selectTown(button.dataset.townButton)));
filters.forEach(button => button.addEventListener("click", () => {
  filter = button.dataset.filter;
  filters.forEach(item => item.setAttribute("aria-pressed", item === button));
  showResults();
}));
states.forEach(button => button.addEventListener("click", () => changeState(button.dataset.state)));
