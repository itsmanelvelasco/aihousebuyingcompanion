const slides = [...document.querySelectorAll(".slide")];
const controls = document.querySelector(".deck-controls");
const previous = document.querySelector("#prev");
const next = document.querySelector("#next");
const count = document.querySelector("#slide-count");
let current = 0;

function showSlide(index) {
  current = Math.min(slides.length - 1, Math.max(0, index));
  slides.forEach((slide, position) => { slide.hidden = position !== current; });
  previous.disabled = current === 0;
  next.disabled = current === slides.length - 1;
  count.textContent = (current + 1) + " de " + slides.length;
}

previous.addEventListener("click", () => showSlide(current - 1));
next.addEventListener("click", () => showSlide(current + 1));
document.querySelector("#print").addEventListener("click", () => window.print());
document.addEventListener("keydown", event => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    showSlide(current + (event.key === "ArrowRight" ? 1 : -1));
  }
});
controls.hidden = false;
showSlide(0);
