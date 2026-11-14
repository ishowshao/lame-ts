#include <config.h>
#include "lame.h"
#include "machine.h"
#include "encoder.h"
#include "util.h"
#include "quantize_pvt.h"
#include "common.h"
int main(void) {
    printf("/** [table_number*12 + row*4 + i] */\n"); pi32("nr_of_sfb_block", &nr_of_sfb_block[0][0][0], 72);
    pi32("pretab", pretab, SBMAX_l);
    printf("export interface SfBandIndex {\n  readonly l: Int32Array;\n  readonly s: Int32Array;\n}\n\nexport const sfBandIndex: readonly SfBandIndex[] = [\n");
    for (int i = 0; i < 9; i++) {
        printf("  {\n    l: new Int32Array(["); for (int j = 0; j < 23; j++) printf("%s%d", j ? ", " : "", sfBandIndex[i].l[j]);
        printf("]),\n    s: new Int32Array(["); for (int j = 0; j < 14; j++) printf("%s%d", j ? ", " : "", sfBandIndex[i].s[j]);
        printf("]),\n  },\n");
    }
    printf("];\n\n");
    return 0;
}
