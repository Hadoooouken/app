(function () {
    var leftPanel = document.querySelector('.app-ui-left');
    var subMenus = Array.prototype.slice.call(
        document.querySelectorAll('.sub-menu[data-parent-button]')
    );

    if (!leftPanel || subMenus.length === 0) {
        return;
    }

    function isMobileViewport() {
        return window.matchMedia('(max-width: 768px)').matches;
    }

    function escapeAttributeValue(value) {
        return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }

    function getTriggerByMenu(menu) {
        var parentButton = menu.getAttribute('data-parent-button');
        if (!parentButton) return null;

        return document.querySelector(
            '[data-button="' + escapeAttributeValue(parentButton) + '"]'
        );
    }

    function clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
    }

    function positionSubMenu(menu) {
        var spacing = 20;
        var panelRect = leftPanel.getBoundingClientRect();
        var wasClosed = !menu.classList.contains('is-open');

        if (wasClosed) {
            menu.classList.add('is-open');
            menu.style.visibility = 'hidden';
        }

        var menuRect = menu.getBoundingClientRect();
        var left;
        var top;

        if (isMobileViewport()) {
            left = panelRect.left + (panelRect.width - menuRect.width) / 2;
            top = panelRect.top - menuRect.height - spacing;
        } else {
            left = panelRect.right + spacing;
            top = (window.innerHeight - menuRect.height) / 2;
        }

        var safeLeft = clamp(left, 10, Math.max(10, window.innerWidth - menuRect.width - 10));
        var safeTop = clamp(top, 10, Math.max(10, window.innerHeight - menuRect.height - 10));

        menu.style.left = Math.round(safeLeft) + 'px';
        menu.style.top = Math.round(safeTop) + 'px';
        menu.style.visibility = '';

        if (wasClosed) {
            menu.classList.remove('is-open');
        }
    }

    function hasActiveBuildTool() {
        return window.state?.mode === 'draw-wall' || window.state?.mode === 'draw-door';
    }

    function closeAllSubMenus(exceptMenu) {
        subMenus.forEach(function (menu) {
            if (menu === exceptMenu) return;

            var parentButton = menu.getAttribute('data-parent-button');

            // build submenu не закрываем, пока активны стена или дверь
            if (parentButton === 'build' && hasActiveBuildTool()) {
                return;
            }

            menu.classList.remove('is-open');
        });
    }

    function openSubMenu(menu) {
        closeAllSubMenus(menu);
        menu.classList.add('is-open');
        positionSubMenu(menu);
    }

    function toggleSubMenu(menu) {
        if (menu.classList.contains('is-open')) {
            // build submenu не закрываем по кнопке, пока активен режим рисования
            if (menu.getAttribute('data-parent-button') === 'build' && hasActiveBuildTool()) {
                return;
            }

            menu.classList.remove('is-open');
            return;
        }

        openSubMenu(menu);
    }

    document.addEventListener('click', function (event) {
        var trigger = event.target.closest('[data-button]');
        var clickedInsideMenu = event.target.closest('.sub-menu');

        if (trigger) {
            var targetMenu = subMenus.find(function (menu) {
                return menu.getAttribute('data-parent-button') === trigger.getAttribute('data-button');
            });

            if (targetMenu) {
                toggleSubMenu(targetMenu);
                return;
            }
        }

        // если активен build tool — submenu строительства не закрываем случайным кликом
        if (hasActiveBuildTool()) {
            if (clickedInsideMenu && clickedInsideMenu.getAttribute('data-parent-button') === 'build') {
                return;
            }

            var buildMenu = document.querySelector('.sub-menu[data-parent-button="build"]');
            if (buildMenu && buildMenu.classList.contains('is-open')) {
                return;
            }
        }

        if (!clickedInsideMenu) {
            closeAllSubMenus(null);
        }
    });

    document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') {
            closeAllSubMenus(null);
        }
    });

    window.addEventListener('resize', function () {
        subMenus.forEach(function (menu) {
            if (menu.classList.contains('is-open')) {
                positionSubMenu(menu);
            }
        });
    });

    subMenus.forEach(function (menu) {
        var trigger = getTriggerByMenu(menu);
        if (!trigger) return;
        positionSubMenu(menu);
    });
})();