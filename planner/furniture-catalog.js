// world units у тебя = cm, значит 200см = 200
export const FURN_CATEGORIES = [
    {
        id: 'living',
        label: 'Гостиная/спальня',
        items: [
            { typeId: 'sofa', label: 'Диван', symbolId: 'divan', w: 200, h: 90 },
            { typeId: 'bed', label: 'Кровать', symbolId: 'f-sofa', w: 200, h: 160 },

        ],
    },
    {
        id: 'kitchen',
        label: 'Кухня',
        items: [
            { typeId: 'kitchen', label: 'Гарнитур', symbolId: 'f-kitchen', w: 240, h: 60 },
        ],
    },
    {
        id: 'bath',
        label: 'Ванная',
        items: [
            { typeId: 'toilet', label: 'Унитаз', symbolId: 'f-toilet', w: 70, h: 40 },
            { typeId: 'bath', label: 'Ванна', symbolId: 'f-bath', w: 170, h: 70 },
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