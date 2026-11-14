#include "newmdct.c"
#include "common.h"
int main(void) {
    printf("/** Polyphase analysis window (Takehiro's reordered layout). */\n"); pf("enwindow", enwindow, N(enwindow));
    printf("/** MDCT windows [block_type*36 + i]; the SHORT_TYPE row also packs tantab_l, cx, ca, cs. */\n"); pf("win", &win[0][0], 4 * NL);
    return 0;
}
