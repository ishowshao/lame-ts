#include "tables.c"
#include "common.h"
int main(void) {
    static const struct { const char *hb, *hl; const uint16_t *t; const uint8_t *l; int n; } T[] = {
        {"t1HB","t1l",t1HB,t1l,4},{"t2HB","t2l",t2HB,t2l,9},{"t3HB","t3l",t3HB,t3l,9},
        {"t5HB","t5l",t5HB,t5l,16},{"t6HB","t6l",t6HB,t6l,16},{"t7HB","t7l",t7HB,t7l,36},
        {"t8HB","t8l",t8HB,t8l,36},{"t9HB","t9l",t9HB,t9l,36},{"t10HB","t10l",t10HB,t10l,64},
        {"t11HB","t11l",t11HB,t11l,64},{"t12HB","t12l",t12HB,t12l,64},{"t13HB","t13l",t13HB,t13l,256},
        {"t15HB","t15l",t15HB,t15l,256},{"t16HB","t16l",t16HB,t16l,256},{"t24HB","t24l",t24HB,t24l,256},
        {"t32HB","t32l",t32HB,t32l,16},{"t33HB","t33l",t33HB,t33l,16}};
    for (int i = 0; i < N(T); i++) { pu16(T[i].hb, T[i].t, T[i].n); pu8(T[i].hl, T[i].l, T[i].n); }
    pu8("t16_5l", t16_5l, N(t16_5l));
    printf("export interface HuffCodeTab {\n  readonly xlen: number;\n  readonly linmax: number;\n  readonly table: Uint16Array | null;\n  readonly hlen: Uint8Array | null;\n}\n\n");
    printf("/** Huffman code tables 0..31 plus the two count1 tables (32, 33). */\nexport const ht: readonly HuffCodeTab[] = [\n");
    for (int i = 0; i < HTN; i++) {
        const char *tn = "null", *ln = "null";
        for (int j = 0; j < N(T); j++) { if (ht[i].table == T[j].t) tn = T[j].hb; if (ht[i].hlen == T[j].l) ln = T[j].hl; }
        if (ht[i].hlen == t16_5l) ln = "t16_5l";
        printf("  { xlen: %u, linmax: %u, table: %s, hlen: %s },\n", ht[i].xlen, ht[i].linmax, tn, ln);
    }
    printf("];\n\n");
    pu32("largetbl", largetbl, 256); pu32("table23", table23, 9); pu32("table56", table56, 16);
    printf("/** [version][index]; version 0 = MPEG-2, 1 = MPEG-1, 2 = MPEG-2.5 */\nexport const bitrate_table: readonly Int32Array[] = [\n");
    for (int v = 0; v < 3; v++) { printf("  new Int32Array(["); for (int i = 0; i < 16; i++) printf("%s%d", i ? ", " : "", bitrate_table[v][i]); printf("]),\n"); }
    printf("];\n\nexport const samplerate_table: readonly Int32Array[] = [\n");
    for (int v = 0; v < 3; v++) { printf("  new Int32Array(["); for (int i = 0; i < 4; i++) printf("%s%d", i ? ", " : "", samplerate_table[v][i]); printf("]),\n"); }
    printf("];\n\n");
    pi32("scfsi_band", scfsi_band, 5);
    return 0;
}
