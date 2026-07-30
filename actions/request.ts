'use server';

import { prisma } from '@/lib/prisma';
import { validatedActionWithUser } from '@/auth/middleware';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { Role, BloodGroup } from '@/types/enums';
import { queueBloodRequestNotification } from '@/jobs/helpers';
import { isValidMoroccanPhone, normalizeMoroccanPhone } from '@/lib/utils';

const BloodRequestSchema = z.object({
    description: z.string().min(1),
    bloodGroup: z.nativeEnum(BloodGroup),
    cityId: z.coerce.number(),
    location: z.string(),
    phone: z
        .string()
        .optional()
        .nullable()
        .refine(phone => !phone || isValidMoroccanPhone(phone), {
            message: 'Invalid Moroccan phone number',
        }),
    status: z.string().default('active'),
});

interface GetRequestsParams {
    page: number;
    pageSize: number;
    search?: string;
    status?: string;
    bloodGroup?: BloodGroup;
    userId?: string;
    region?: string;
    cityId?: string;
}

export async function getBloodRequests({
    page,
    pageSize,
    search = '',
    status,
    bloodGroup,
    region,
    cityId,
}: GetRequestsParams) {
    const where: any = {
        AND: [
            search
                ? {
                      OR: [
                          {
                              description: {
                                  contains: search,
                                  mode: 'insensitive' as const,
                              },
                          },
                          {
                              city: {
                                  name: {
                                      contains: search,
                                      mode: 'insensitive' as const,
                                  },
                              },
                          },
                      ],
                  }
                : {},
            status ? { status } : {},
            bloodGroup ? { bloodGroup } : {},
        ],
    };
    if (cityId) {
        where.AND.push({ cityId: Number(cityId) });
    } else if (region) {
        where.AND.push({ city: { regionId: Number(region) } });
    }

    const [requests, totalCount] = await Promise.all([
        prisma.bloodRequest.findMany({
            where,
            skip: (page - 1) * pageSize,
            take: pageSize,
            orderBy: { createdAt: 'desc' },
            include: {
                user: {
                    select: {
                        id: true,
                        name: true,
                        email: true,
                        deletedAt: true,
                    },
                },
                city: {
                    select: {
                        id: true,
                        name: true,
                        regionId: true,
                    },
                },
            },
        }),
        prisma.bloodRequest.count({ where }),
    ]);

    return { requests, totalCount };
}

export const getBloodRequest = async (id: number) => {
    const request = await prisma.bloodRequest.findUnique({
        where: { id },
        include: {
            user: {
                select: {
                    id: true,
                    name: true,
                    email: true,
                    deletedAt: true,
                },
            },
            city: {
                select: {
                    id: true,
                    name: true,
                    regionId: true,
                },
            },
        },
    });

    if (!request) {
        return null;
    }

    return request;
};

export const createBloodRequest = validatedActionWithUser(
    BloodRequestSchema,
    async (data, _, user) => {
        if (user.role !== Role.ADMIN) {
            return { error: 'Not authorized' };
        }
        try {
            const { cityId, ...createData } = data;

            const newRequest = await prisma.bloodRequest.create({
                data: {
                    ...createData,
                    phone: createData.phone
                        ? normalizeMoroccanPhone(createData.phone)
                        : createData.phone,
                    cityId,
                    userId: null,
                },
            });

            await queueBloodRequestNotification(newRequest.id);

            revalidatePath('/dashboard/requests');
            return { success: 'Blood request created successfully' };
        } catch (error) {
            console.error('Create blood request error:', error);
            return {
                error:
                    error instanceof Error
                        ? error.message
                        : 'Failed to create blood request',
            };
        }
    },
);

export const updateBloodRequest = validatedActionWithUser(
    BloodRequestSchema.extend({ id: z.coerce.number() }),
    async (data, _, user) => {
        try {
            const request = await prisma.bloodRequest.findUnique({
                where: { id: data.id },
            });

            if (!request) {
                return { error: 'Blood request not found' };
            }

            // Only admin or the request creator can update
            if (user.role !== Role.ADMIN && request.userId !== user.id) {
                return { error: 'Not authorized to update this request' };
            }

            const { id, cityId, ...updateData } = data;

            await prisma.bloodRequest.update({
                where: { id },
                data: {
                    ...updateData,
                    phone: updateData.phone
                        ? normalizeMoroccanPhone(updateData.phone)
                        : updateData.phone,
                    cityId,
                },
            });

            revalidatePath('/dashboard/requests');
            return { success: 'Blood request updated successfully' };
        } catch (error) {
            console.error('Update blood request error:', error);
            return {
                error:
                    error instanceof Error
                        ? error.message
                        : 'Failed to update blood request',
            };
        }
    },
);

export const deleteBloodRequest = validatedActionWithUser(
    z.object({ id: z.coerce.number() }),
    async (data, _, user) => {
        try {
            const request = await prisma.bloodRequest.findUnique({
                where: { id: data.id },
            });

            if (!request) {
                return { error: 'Blood request not found' };
            }

            // Only admin or the request creator can delete
            if (user.role !== Role.ADMIN && request.userId !== user.id) {
                return { error: 'Not authorized to delete this request' };
            }

            await prisma.bloodRequest.delete({
                where: { id: data.id },
            });

            revalidatePath('/dashboard/requests');
            return { success: 'Blood request deleted successfully' };
        } catch (error) {
            return {
                error: 'Failed to delete blood request',
            };
        }
    },
);
