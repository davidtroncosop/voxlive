(function () {
  "use strict";

  const burger = document.querySelector(".nav__burger");
  const menu = document.querySelector("#mobile-menu");

  if (!burger || !menu) return;

  function setOpen(isOpen) {
    burger.classList.toggle("is-open", isOpen);
    burger.setAttribute("aria-expanded", isOpen ? "true" : "false");
    burger.setAttribute("aria-label", isOpen ? "Cerrar menú" : "Abrir menú");
    if (isOpen) {
      menu.removeAttribute("hidden");
    } else {
      menu.setAttribute("hidden", "");
    }
  }

  burger.addEventListener("click", function () {
    const isOpen = burger.classList.contains("is-open");
    setOpen(!isOpen);
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && burger.classList.contains("is-open")) {
      setOpen(false);
      burger.focus();
    }
  });

  const links = menu.querySelectorAll("a, button");
  links.forEach(function (link) {
    link.addEventListener("click", function () {
      setOpen(false);
    });
  });
})();
