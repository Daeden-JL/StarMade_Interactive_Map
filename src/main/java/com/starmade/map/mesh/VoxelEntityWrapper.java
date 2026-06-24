package com.starmade.map.mesh;

import org.schema.game.common.controller.SegmentController;
import org.schema.game.common.controller.SegmentBufferInterface;
import org.schema.game.common.controller.Vector3iSegment;

public class VoxelEntityWrapper implements VoxelEntity {
    private final SegmentController controller;

    public VoxelEntityWrapper(SegmentController controller) {
        this.controller = controller;
    }

    @Override
    public int getId() {
        return controller.getId();
    }

    @Override
    public Vector3iSegment getMinPos() {
        return controller.getMinPos();
    }

    @Override
    public Vector3iSegment getMaxPos() {
        return controller.getMaxPos();
    }

    @Override
    public SegmentBufferInterface getSegmentBuffer() {
        return controller.getSegmentBuffer();
    }
}
