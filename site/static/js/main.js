!function () {
    var container = document.querySelector(".container"),
        menu_mobile_trigger = document.querySelector(".menu-trigger"),
        menu_mobile = document.querySelector(".menu-mobile"),
        page_form = document.querySelector(".pagination__form"),
        phone_width = getComputedStyle(document.body).getPropertyValue("--phoneWidth"),
        is_phone = function () {
            return window.matchMedia(phone_width).matches
        },
	was_phone = is_phone(),
        hide_mobile_menu = function () {
            menu_mobile_trigger &&
                menu_mobile_trigger.removeAttribute("open")
        },
	// Close the mobile menu if we zoomed out of phone mode.
	toggle_vis = function () {
            was_phone && !is_phone() &&
		hide_mobile_menu();
	    was_phone = is_phone();
        };

    page_form &&
        (page_form.onsubmit = function(event) {
            if (this.page.value == 1) {
                loc = this.action.slice(0, -5)
            }
            else {
                loc = this.action += this.page.value + '/';
            }
            event.preventDefault();
            window.location.href = loc;
        }),
    // Adds support for clicking anywhere to close the mobile menu.
    menu_mobile_trigger &&
        menu_mobile_trigger.addEventListener("click", function (event) {
            return event.stopPropagation()
        }),
    menu_mobile &&
        menu_mobile.addEventListener("click", function (event) {
            return event.stopPropagation()
        }),
    document.body.addEventListener("click", function () {
        if (is_phone() && menu_mobile_trigger.hasAttribute("open")) {
            hide_mobile_menu()
        }
    }),
    window.addEventListener("resize", toggle_vis);
}();
