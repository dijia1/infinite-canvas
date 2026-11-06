"use client";

import { useLayoutEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { fetchPortalSession } from "@/services/api/session";

type PublicAssetManagementCapabilitySnapshot = {
    open: boolean;
    openingId: number | null;
    confirmedOpeningId: number | null;
    isFetching: boolean;
    isError: boolean;
    canManagePublicAssets?: boolean;
};

type OpeningState = {
    open: boolean;
    id: number | null;
};

let openingSequence = 0;

export function hasFreshPublicAssetManagementCapability(snapshot: PublicAssetManagementCapabilitySnapshot) {
    return Boolean(
        snapshot.open &&
            snapshot.openingId !== null &&
            snapshot.confirmedOpeningId === snapshot.openingId &&
            !snapshot.isFetching &&
            !snapshot.isError &&
            snapshot.canManagePublicAssets,
    );
}

export function usePublicAssetManagementCapability(open: boolean) {
    const [opening, setOpening] = useState<OpeningState>({ open: false, id: null });

    useLayoutEffect(() => {
        setOpening((current) => {
            if (current.open === open) return current;
            return open ? { open: true, id: ++openingSequence } : { open: false, id: current.id };
        });
    }, [open]);

    const openingId = open && opening.open ? opening.id : null;
    const session = useQuery({
        queryKey: ["portal-session", "public-assets", openingId],
        queryFn: fetchPortalSession,
        enabled: openingId !== null,
        retry: false,
        staleTime: 0,
        refetchOnMount: "always",
    });
    const isError = session.isError || session.isRefetchError;
    const confirmedOpeningId = session.isSuccess && !session.isFetching && !isError ? openingId : null;

    return hasFreshPublicAssetManagementCapability({
        open,
        openingId,
        confirmedOpeningId,
        isFetching: session.isFetching,
        isError,
        canManagePublicAssets: session.data?.canManagePublicAssets,
    });
}
