# Kit de marca de relo.cat

El manual, el prototipo y la plantilla viven juntos en este directorio. Abre [index.html](index.html) en un navegador para navegar entre ellos.

| Recurso | Archivo |
| --- | --- |
| Manual de marca | [index.html](index.html) |
| Prototipo de comparación de municipios | [app.html](app.html) |
| Plantilla editable de cinco diapositivas | [presentation.html](presentation.html) |
| Tipografía, colores y espaciado | [brand.css](brand.css) |
| Símbolos, iconos e ilustraciones SVG | [assets](assets/) |

La plantilla admite las flechas del teclado y exportación a PDF desde «Imprimir / PDF». El manual también tiene estilos de impresión. La tipografía web carga Montserrat desde Google Fonts y usa Segoe UI cuando la fuente no está disponible. Para usarla en aplicaciones de escritorio, descarga Montserrat desde [Google Fonts](https://fonts.google.com/specimen/Montserrat).

El prototipo usa ejemplos etiquetados y permite revisar filtros, fichas y estados de carga, vacío y error. El producto y sus fuentes se documentan en el [README del repositorio](../../README.md).

## Publicación

Es una web estática. Copia los archivos del kit y la carpeta `assets/` a `dist/` en el proyecto de Sites. El punto de entrada es `dist/index.html`. Sirve ese directorio completo para mantener operativas las descargas y la navegación.
