export const FURN_CATEGORIES = [
    {
        id: 'living',
        label: 'Гостиная/спальня',
        items: [
            { typeId: 'sofa-small', label: 'Диван малый', symbolId: 'mebel-divan-small', w: 150, h: 82 },
            { typeId: 'sofa-medium', label: 'Диван средний', symbolId: 'mebel-divan-normal', w: 200, h: 82 },
            { typeId: 'sofa-big', label: 'Диван большой', symbolId: 'mebel-divan-big', w: 250, h: 82 },

            { typeId: 'bed-double', label: 'Кровать двуспальная', symbolId: 'mebel-krovat-big', w: 160, h: 200 },
            { typeId: 'bed-single', label: 'Кровать односпальная', symbolId: 'mebel-krovat-small', w: 90, h: 200 },
            { typeId: 'bedside-table', label: 'Прикроватная тумба', symbolId: 'mebel-tumba', w: 50, h: 45 },

            { typeId: 'desk', label: 'Рабочее место', symbolId: 'mebel-komp-stol', w: 130, h: 110 },
            { typeId: 'coffee-table', label: 'Журнальный стол', symbolId: 'mebel-jurn-stol', w: 90, h: 50 },
            { typeId: 'tv', label: 'Телевизор', symbolId: 'mebel-tv', w: 110, h: 10 },

            { typeId: 'wardrobe-1', label: 'Шкаф 1м', symbolId: 'mebel-skaf-1', w: 100, h: 54 },
            { typeId: 'wardrobe-2', label: 'Шкаф 2м', symbolId: 'mebel-skaf-2', w: 200, h: 54 },
            { typeId: 'wardrobe-3', label: 'Шкаф 3м', symbolId: 'mebel-skaf-3', w: 300, h: 54 },
        ],
    },

    {
        id: 'kitchen',
        label: 'Кухня',
        items: [
            { typeId: 'kitchen-2', label: 'Кухня 2м', symbolId: 'mebel-kuhnya-small', w: 200, h: 60 },
            { typeId: 'kitchen-2-5', label: 'Кухня 2.5м', symbolId: 'mebel-kuhnya-normal', w: 240, h: 60 },
            { typeId: 'kitchen-3', label: 'Кухня 3м', symbolId: 'mebel-kuhnya-big', w: 300, h: 60 },

            { typeId: 'table-small', label: 'Кухонный стол малый', symbolId: 'mebel-stol-small', w: 80, h: 60 },
            { typeId: 'table-medium', label: 'Кухонный стол средний', symbolId: 'mebel-stol-normal', w: 120, h: 70 },
            { typeId: 'table-big', label: 'Кухонный стол большой', symbolId: 'mebel-stol-big', w: 160, h: 90 },
        ],
    },

    {
        id: 'bath',
        label: 'Ванная',
        items: [
            { typeId: 'toilet', label: 'Унитаз', symbolId: 'mebel-unitaz', w: 36, h: 62 },
            { typeId: 'bath', label: 'Ванна', symbolId: 'mebel-vanna', w: 180, h: 80 },
            { typeId: 'sink', label: 'Раковина', symbolId: 'mebel-rakovina', w: 66, h: 50 },
            { typeId: 'shower', label: 'Душевая кабина', symbolId: 'mebel-kabina', w: 90, h: 90 },
        ],
    },
]

export const FURN_BY_TYPE = new Map(
    FURN_CATEGORIES.flatMap(c => c.items.map(it => [it.typeId, it]))
)

// загружаем sprite.svg и закидываем <symbol> внутрь defs текущего SVG
export async function loadFurnitureSpriteIntoDefs(
    draw,
    url = new URL('./assets/sprite.svg', import.meta.url).toString()
) {
    const defs = draw.defs()

    // уже загружено?
    if (defs.node.querySelector('[data-furn-sprite]')) return

    const res = await fetch(url)
    if (!res.ok) throw new Error(`Furniture sprite not found: ${res.status} ${res.statusText} (${url})`)

    const txt = await res.text()
    const inner = txt.match(/<svg[^>]*>([\s\S]*?)<\/svg>/i)?.[1] ?? txt

    defs.node.insertAdjacentHTML('beforeend', `<g data-furn-sprite>${inner}</g>`)
}