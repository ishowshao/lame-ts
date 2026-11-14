/* Shared print helpers for the table dumpers. */
#include <stdio.h>
#include <stdint.h>
#define N(a) ((int)(sizeof(a)/sizeof((a)[0])))
static void pf(const char *name, const float *p, int n) {
    printf("export const %s = /* @__PURE__ */ new Float32Array([", name);
    for (int i = 0; i < n; i++) printf("%s%s%.9g", i ? "," : "", (i % 6 == 0) ? "\n  " : " ", (double)p[i]);
    printf("\n]);\n\n");
}
static void pd(const char *name, const double *p, int n) {
    printf("export const %s = /* @__PURE__ */ new Float64Array([", name);
    for (int i = 0; i < n; i++) printf("%s%s%.17g", i ? "," : "", (i % 4 == 0) ? "\n  " : " ", p[i]);
    printf("\n]);\n\n");
}
#define PINT(fn, T, ARR, FMT, PER) \
static void fn(const char *name, const T *p, int n) { \
    printf("export const %s = /* @__PURE__ */ new " ARR "([", name); \
    for (int i = 0; i < n; i++) printf("%s%s" FMT, i ? "," : "", (i % PER == 0) ? "\n  " : " ", p[i]); \
    printf("\n]);\n\n"); }
PINT(pi32, int, "Int32Array", "%d", 16)
PINT(pu32, uint32_t, "Uint32Array", "0x%x", 8)
PINT(pu16, uint16_t, "Uint16Array", "%u", 16)
PINT(pu8, uint8_t, "Uint8Array", "%u", 16)
